package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/httputil"
	"fast_chat/model"
	"fast_chat/ratelimit"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
	"fast_chat/transport"
)

func newTestRateLimiter(limit int, window time.Duration) *ratelimit.RateLimiter {
	rl := ratelimit.New(limit, window, 10000)

	// Stop the background cleanup loop in tests so its 1-second tick
	// does not race with assertions.
	rl.Close()

	return rl
}

func TestRateLimiterAllowsUnderLimit(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(3, time.Minute)

	for i := range 3 {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("call %d: allow returned false under the limit", i+1)
		}
	}
}

func TestRateLimiterBlocksOverLimit(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(3, time.Minute)

	for i := range 3 {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("call %d: should be allowed", i+1)
		}
	}

	if rl.Allow("1.2.3.4") {
		t.Fatal("fourth call must be rejected")
	}
}

func TestRateLimiterIsolatesClients(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(2, time.Minute)

	if !rl.Allow("a") || !rl.Allow("a") {
		t.Fatal("a: under-limit calls should be allowed")
	}

	if rl.Allow("a") {
		t.Fatal("a: third call must be rejected")
	}

	if !rl.Allow("b") {
		t.Fatal("b: should not be affected by a's rate limit")
	}
}

func TestRateLimiterResetsAfterWindow(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(2, 50*time.Millisecond)

	if !rl.Allow("1.2.3.4") || !rl.Allow("1.2.3.4") {
		t.Fatal("two calls under the limit should be allowed")
	}

	if rl.Allow("1.2.3.4") {
		t.Fatal("third call inside the window must be rejected")
	}

	time.Sleep(80 * time.Millisecond)

	if !rl.Allow("1.2.3.4") {
		t.Fatal("after the window the limit must reset")
	}
}

func TestRateLimiterConcurrent(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(100, time.Minute)

	var wg sync.WaitGroup

	allowed := make(chan bool, 200)

	for range 200 {
		wg.Go(func() {
			allowed <- rl.Allow("shared")
		})
	}

	wg.Wait()
	close(allowed)

	var count int
	for ok := range allowed {
		if ok {
			count++
		}
	}

	if count != 100 {
		t.Fatalf("expected exactly 100 allowed calls under concurrent load, got %d", count)
	}
}

// TestRequestLogMiddlewarePreservesFlusher guards against the statusWriter
// wrapper dropping http.Flusher: the SSE stream type-asserts it and would
// fail with 500 "streaming unsupported" behind the logging middleware.
func TestRequestLogMiddlewarePreservesFlusher(t *testing.T) {
	streamed := false
	h := requestLogMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("ResponseWriter lost http.Flusher behind requestLogMiddleware")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
		flusher.Flush()
		streamed = true
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events", nil)
	h.ServeHTTP(rec, req)

	if !streamed {
		t.Fatal("handler did not reach the streaming path")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Body.String() != "hello" {
		t.Errorf("unexpected body %q", rec.Body.String())
	}
	if !rec.Flushed {
		t.Error("expected the flush to reach the underlying writer")
	}
}

// TestFullMiddlewareChainIntegration exercises the exact outer middleware
// chain assembled in main() (request ID → request log → security headers →
// CORS → general rate limit → SPA fallback) on top of the Huma transport with
// its infra-mux fallback. It verifies cross-cutting concerns on real traffic.
func TestFullMiddlewareChainIntegration(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{},
	); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server:  config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:    config.CORSConfig{Origin: "*"},
		Auth:    config.AuthConfig{TokenExpiry: time.Hour, TokenExpiryWarning: 5 * time.Minute},
		Uploads: config.UploadsConfig{Dir: t.TempDir()},
	}

	hub := sse.NewHub(time.Minute)
	st := store.New(db)
	svc := service.New(st, cfg, hub, nil)

	key, err := federation.LoadOrGenerateKeys(filepath.Join(t.TempDir(), "fed.key"))
	if err != nil {
		t.Fatal(err)
	}

	fm := federation.New(key, cfg.Server.Domain, "http", 5)
	api := transport.New(&transport.Deps{
		Hub:           hub,
		Store:         st,
		Svc:           svc,
		Cfg:           cfg,
		FedManager:    fm,
		FedClient:     federation.NewClient(fm, cfg.Server.Domain, "http", 5),
		PushPublicKey: func() (string, bool) { return "", false },
	})

	// A fake built frontend so the SPA fallback is active for this test.
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"),
		[]byte("<!doctype html><html><body><div id=\"root\"></div></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}

	infraMux := http.NewServeMux()
	infraMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httputil.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	rl := newTestRateLimiter(7, time.Minute)
	extractor := ratelimit.NewClientIPExtractor(nil)

	root := httputil.RequestIDMiddleware(
		requestLogMiddleware(
			securityHeadersMiddleware(
				corsMiddleware("*")(
					rateLimitMiddleware(rl, extractor)(
						spaFallbackMiddleware(staticDir)(api.FallbackHandler(infraMux)),
					),
				),
			),
		),
	)

	do := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, http.NoBody)
		req.Header.Set("X-Request-ID", "integration-req-1")
		root.ServeHTTP(rec, req)

		return rec
	}

	// Migrated API: Huma serves /api/config with all cross-cutting headers.
	rec := do("/api/config")
	if rec.Code != http.StatusOK {
		t.Fatalf("api/config: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	if got := rec.Header().Get("X-Request-ID"); got != "integration-req-1" {
		t.Errorf("X-Request-ID = %q, want incoming id echoed", got)
	}

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("CORS header = %q", got)
	}

	for _, header := range []string{"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "X-XSS-Protection"} {
		if rec.Header().Get(header) == "" {
			t.Errorf("missing security header %s", header)
		}
	}

	// Legacy mux fallback: health probes stay reachable.
	rec = do("/healthz")
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz: expected 200, got %d", rec.Code)
	}

	if got := rec.Header().Get("X-Request-ID"); got != "integration-req-1" {
		t.Errorf("healthz X-Request-ID = %q", got)
	}

	// With a built frontend present, backend routes still win over the SPA
	// shell: /docs must be the API documentation, not the React app.
	rec = do("/docs")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "root") {
		t.Fatalf("/docs must serve the docs page, not the SPA shell (code=%d)", rec.Code)
	}

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "elements-api") {
		t.Fatalf("/docs missing elements-api markup: %s", rec.Body.String())
	}

	// Unknown client-side paths fall back to the SPA shell.
	rec = do("/chats/42")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "root") {
		t.Fatalf("SPA fallback broken: code=%d body=%s", rec.Code, rec.Body.String())
	}

	// General rate limit trips the whole chain: 3 allowed, the 4th is 429.
	for range 3 {
		if rec := do("/api/config"); rec.Code != http.StatusOK {
			t.Fatalf("expected 200 within limit, got %d", rec.Code)
		}
	}

	if rec := do("/api/config"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after limit, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestShutdownDrainsWithAnOpenSSEStream covers the shutdown order that broke
// graceful restarts. An open event stream never becomes idle, so draining with
// one still attached blocks until the deadline expires. Closing the hub first
// makes the handler return, so the drain completes immediately.
func TestShutdownDrainsWithAnOpenSSEStream(t *testing.T) {
	dir := t.TempDir()

	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "t.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{},
	); err != nil {
		t.Fatal(err)
	}

	st := store.New(db)

	cfg := &config.Config{
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
		Auth:   config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
	}

	hub := sse.NewHub(time.Minute)
	svc := service.New(st, cfg, hub, nil)

	fedKey, err := federation.LoadOrGenerateKeys(filepath.Join(dir, "keys"))
	if err != nil {
		t.Fatal(err)
	}

	fedManager := federation.New(fedKey, "localhost:8080", "http", 1)
	fedClient := federation.NewClient(fedManager, "localhost:8080", "http", 1)

	tr := transport.New(&transport.Deps{
		Hub: hub, Store: st, Svc: svc, Cfg: cfg,
		FedManager: fedManager, FedClient: fedClient,
	})

	// A real listener, so Shutdown has a non-idle connection to drain.
	srv := httptest.NewServer(tr.Handler())

	// Close must not block: if the stream is still attached (the failure this
	// test guards), a plain srv.Close would wait on it forever.
	t.Cleanup(func() {
		srv.CloseClientConnections()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		_ = srv.Config.Shutdown(ctx)
	})

	// Signalled once the client has seen the connected event, which the
	// handler writes only after registering the connection. That makes this a
	// deterministic point to start the shutdown from, unlike a sleep.
	//
	// The channel carries an error rather than being closed, so a failed read
	// is not reported as a connection that never appeared.
	streamReady := make(chan error, 1)
	streamDone := make(chan struct{})

	go func() {
		defer close(streamDone)

		resp, err := http.Get(srv.URL + "/api/events?connectionId=shutdown-test") //nolint:noctx // short-lived test client
		if err != nil {
			streamReady <- fmt.Errorf("opening the stream: %w", err)

			return
		}

		defer resp.Body.Close()

		buf := make([]byte, 512)

		if _, err := resp.Body.Read(buf); err != nil {
			streamReady <- fmt.Errorf("reading the first SSE event: %w", err)
		} else {
			streamReady <- nil
		}

		// Read until the server closes the stream.
		_, _ = io.Copy(io.Discard, resp.Body)
	}()

	select {
	case err := <-streamReady:
		if err != nil {
			t.Fatalf("the SSE stream did not deliver its first event: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the SSE stream produced nothing at all; the connection was not registered")
	}

	// Live limiters, as in main: shutdown closes each one exactly once, so
	// they must not be pre-closed the way newTestRateLimiter leaves them.
	rl := &limiters{
		general:    ratelimit.New(1, time.Minute, 1000),
		sendCode:   ratelimit.New(1, time.Minute, 1000),
		verifyCode: ratelimit.New(1, time.Minute, 1000),
		register:   ratelimit.New(1, time.Minute, 1000),
		sseAuth:    ratelimit.New(1, time.Minute, 1000),
	}

	done := make(chan struct{})

	go func() {
		defer close(done)

		shutdown(shutdownDeps{
			server:     srv.Config,
			hub:        hub,
			fedManager: fedManager,
			fedClient:  fedClient,
			store:      st,
			limiters:   rl,
			budget:     5 * time.Second,
		}, context.Background())
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown did not complete while an SSE stream was open")
	}

	select {
	case <-streamDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the SSE stream outlived the shutdown")
	}
}
