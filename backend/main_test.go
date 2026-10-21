package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/calls"
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
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{},
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

	fm := federation.New(key, cfg.Server.Domain, "http", 5, false)
	api := transport.New(&transport.Deps{
		Hub:           hub,
		Store:         st,
		Svc:           svc,
		Cfg:           cfg,
		FedManager:    fm,
		FedClient:     federation.NewClient(fm, cfg.Server.Domain, "http", 5, false),
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
			securityHeadersMiddleware(extractor)(
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

// TestShutdownEndsCallsBeforeTheHub covers the order of the shutdown for the
// calls: the clients have to receive the final state, and after the hub is
// closed no event is delivered any more.
func TestShutdownEndsCallsBeforeTheHub(t *testing.T) {
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
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{},
	); err != nil {
		t.Fatal(err)
	}

	st := store.New(db)

	hub := sse.NewHub(time.Minute)
	cfg := &config.Config{
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
	}
	svc := service.New(st, cfg, hub, nil)

	callManager := calls.NewManager(st.IsOnline)
	svc.SetCallManager(callManager)

	call, err := callManager.CreateCall("alice:localhost:8080", "bob:localhost:8080", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	// A connection of one of the participants, so the ending reaches it.
	conn := hub.Register("conn-1")
	if err := hub.Authenticate("conn-1", "alice:localhost:8080", "token", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	deps := shutdownDeps{
		server:   &http.Server{Addr: ":0"},
		hub:      hub,
		store:    st,
		limiters: newLimiters(testConfig()),
		calls:    callManager,
		budget:   time.Second,
	}

	shutdown(&deps, context.Background())

	stored, ok := callManager.Get(call.ID)
	if !ok {
		t.Fatal("the call is gone")
	}

	if stored.State != calls.StateEnded {
		t.Fatalf("state = %q, want ended", stored.State)
	}

	select {
	case event := <-conn.Channel:
		if event.Event != "call_ended" {
			t.Fatalf("event = %q, want call_ended", event.Event)
		}
	default:
		t.Fatal("the ending did not reach the hub")
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
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{},
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

	fedManager := federation.New(fedKey, "localhost:8080", "http", 1, false)
	fedClient := federation.NewClient(fedManager, "localhost:8080", "http", 1, false)

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

		shutdown(&shutdownDeps{
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

// TestServeUntilSignalFailsFastOnABindConflict covers the process that starts
// without ever listening. The failure used to be logged inside the serving
// goroutine and runServer then waited on a signal forever, so a port already in
// use left a live process holding the SQLite file and reporting a healthy PID
// while nothing answered on it.
func TestServeUntilSignalFailsFastOnABindConflict(t *testing.T) {
	// Occupy a port so the bind below cannot succeed.
	occupied, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	defer occupied.Close()

	// The teardown runs on this path too, so it needs the same dependencies
	// production hands it.
	dir := t.TempDir()
	st := newTestStore(t, dir)
	hub := sse.NewHub(time.Minute)

	defer hub.Close()

	fedManager, fedClient := newTestFederation(t, dir)

	// Nothing ever signals: the old code would block here indefinitely.
	quit := make(chan os.Signal)

	done := make(chan error, 1)

	addr := occupied.Addr().String()

	go func() {
		done <- serveUntilSignal(
			func() error { return http.ListenAndServe(addr, http.NotFoundHandler()) },
			&shutdownDeps{
				server:     &http.Server{Addr: addr, Handler: http.NotFoundHandler()},
				hub:        hub,
				fedManager: fedManager,
				fedClient:  fedClient,
				store:      st,
				limiters:   newLimiters(testConfig()),
				budget:     2 * time.Second,
			},
			quit,
		)
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("serveUntilSignal returned nil after failing to bind; the caller would keep running as a zombie")
		}

		if !errors.Is(err, syscall.EADDRINUSE) {
			t.Errorf("err = %v, want it to wrap EADDRINUSE", err)
		}

		if !strings.Contains(err.Error(), occupied.Addr().String()) {
			t.Errorf("err = %q, want it to name the address it could not bind", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serveUntilSignal never returned: the bind failure was swallowed and the process waited for a signal")
	}
}

// TestServeUntilSignalReturnsNilOnShutdown is the other half: a normal stop
// must not look like a failure, or the process would exit non-zero on every
// deploy.
func TestServeUntilSignalReturnsNilOnShutdown(t *testing.T) {
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	st := newTestStore(t, dir)
	hub := sse.NewHub(time.Minute)

	defer hub.Close()

	fedManager, fedClient := newTestFederation(t, dir)

	srv := &http.Server{Handler: http.NotFoundHandler()}

	done := make(chan error, 1)

	go func() {
		done <- serveUntilSignal(func() error { return srv.Serve(listener) }, &shutdownDeps{
			server:     srv,
			hub:        hub,
			fedManager: fedManager,
			fedClient:  fedClient,
			store:      st,
			limiters:   newLimiters(testConfig()),
			budget:     2 * time.Second,
		}, make(chan os.Signal))
	}()

	// Wait for the listener to come up, then stop it the way a signal would.
	go func() {
		for range 100 {
			if conn, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", listener.Addr().String()); err == nil {
				_ = conn.Close()

				break
			}

			time.Sleep(10 * time.Millisecond)
		}

		_ = srv.Close()
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("a normal shutdown reported a failure: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serveUntilSignal never returned after the listener was closed")
	}
}

// testConfig is the minimal config the shutdown paths need.
func testConfig() *config.Config {
	return &config.Config{
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
		Auth:   config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
		RateLimits: config.RateLimitsConfig{
			General:    config.RateLimitConfig{Limit: 600, Window: time.Minute},
			SendCode:   config.RateLimitConfig{Limit: 5, Window: time.Minute},
			VerifyCode: config.RateLimitConfig{Limit: 5, Window: time.Minute},
			Register:   config.RateLimitConfig{Limit: 5, Window: time.Hour},
		},
	}
}

// newTestStore opens a file-backed store with the production schema applied.
func newTestStore(t *testing.T, dir string) *store.Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "t.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{},
	); err != nil {
		t.Fatal(err)
	}

	return store.New(db)
}

// newTestFederation builds the federation pair with keys in dir, which the
// teardown closes.
func newTestFederation(t *testing.T, dir string) (*federation.Manager, *federation.Client) {
	t.Helper()

	fedKey, err := federation.LoadOrGenerateKeys(filepath.Join(dir, "keys"))
	if err != nil {
		t.Fatal(err)
	}

	return federation.New(fedKey, "localhost:8080", "http", 1, false),
		federation.NewClient(federation.New(fedKey, "localhost:8080", "http", 1, false), "localhost:8080", "http", 1, false)
}

// The strict transport security header is only sent on a secure connection.
// The typical deployment terminates TLS at a reverse proxy, so the scheme
// comes from the header of a trusted proxy.
func TestStrictTransportSecurityFollowsTheForwardedScheme(t *testing.T) {
	handler := securityHeadersMiddleware(ratelimit.NewClientIPExtractor([]string{"10.0.0.0/8"}))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)

	do := func(remoteAddr, forwardedProto string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		req.RemoteAddr = remoteAddr

		if forwardedProto != "" {
			req.Header.Set("X-Forwarded-Proto", forwardedProto)
		}

		handler.ServeHTTP(rec, req)

		return rec
	}

	// A trusted proxy that reports https.
	if got := do("10.1.2.3:1234", "https").Header().Get("Strict-Transport-Security"); got == "" {
		t.Error("expected the strict transport security header behind a trusted proxy")
	}

	// A trusted proxy that reports plain http.
	if got := do("10.1.2.3:1234", "http").Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("strict transport security header on a plain connection: %q", got)
	}

	// An untrusted peer cannot claim a secure connection.
	if got := do("203.0.113.7:1234", "https").Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("strict transport security header from an untrusted peer: %q", got)
	}
}
