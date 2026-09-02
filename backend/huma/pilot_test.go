package huma

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/ratelimit"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

func newPilotTestServer(t *testing.T) *Pilot {
	t.Helper()

	return newPilotTestServerWithRL(t, nil)
}

// newPilotTestServerWithRL builds a pilot wired with the given rate limiters
// (nil disables the transport middleware).
func newPilotTestServerWithRL(t *testing.T, rl *RateLimiters) *Pilot {
	t.Helper()

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
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
		Auth:   config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
	}

	hub := sse.NewHub(service.TypingThrottleInterval * 5)
	st := store.New(db)
	svc := service.New(st, cfg, hub, nil)

	return NewPilot(hub, st, svc, cfg, rl)
}

func TestPilotSSEConnected(t *testing.T) {
	pilot := newPilotTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events?connectionId=test-conn-1", http.NoBody)
	rec := httptest.NewRecorder()

	// Use a context with timeout so the test doesn't hang on the endless loop.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)

	pilot.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "event: connected") {
		t.Fatalf("expected connected event, got: %q", body)
	}

	if !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("expected status ok, got: %q", body)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
}

func TestPilotSSEMissingConnectionID(t *testing.T) {
	pilot := newPilotTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events", http.NoBody)
	rec := httptest.NewRecorder()

	pilot.Handler().ServeHTTP(rec, req)

	// Missing connectionId returns 400 to match legacy behavior.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestPilotSSEStreamStaysOpen(t *testing.T) {
	pilot := newPilotTestServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events?connectionId=open-test", http.NoBody).WithContext(ctx)
	rec := httptest.NewRecorder()

	pilot.Handler().ServeHTTP(rec, req)

	// The stream should stay open for the duration of the context and emit
	// the connected event. If it closed early, we'd see no output.
	body := rec.Body.String()
	if !strings.Contains(body, "event: connected") {
		t.Fatalf("expected connected event before stream close, got: %q", body)
	}
}

func TestTransportRateLimit(t *testing.T) {
	rl := &RateLimiters{
		Extractor: ratelimit.NewClientIPExtractor(nil),
		SendCode:  ratelimit.New(1, time.Minute, 10000),
	}
	pilot := newPilotTestServerWithRL(t, rl)
	t.Cleanup(func() { rl.SendCode.Close() })

	body := `{"email":"test@example.com"}`

	for i := range 2 {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		pilot.Handler().ServeHTTP(rec, req)

		if i == 0 {
			if rec.Code != http.StatusOK {
				t.Fatalf("first request: expected 200, got %d: %s", rec.Code, rec.Body.String())
			}

			continue
		}

		// Second request from the same IP exceeds the limit; legacy shape is a
		// plain-text 429 from http.Error.
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("second request: expected 429, got %d: %s", rec.Code, rec.Body.String())
		}

		if got := rec.Body.String(); got != "too many requests\n" {
			t.Errorf("429 body = %q, want legacy plain-text form", got)
		}
	}
}

func TestTransportMaxBody(t *testing.T) {
	pilot := newPilotTestServer(t)

	// Oversized body (> Huma's built-in 1MB MaxBodyBytes) is rejected before
	// it can reach the service. Huma answers 413 (legacy: 400).
	big := strings.Repeat("a", 2<<20)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"`+big+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	pilot.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", rec.Code)
	}
}

// newFallbackTestServer wires the pilot behind FallbackHandler over a legacy
// mux that fails the test if a migrated route ever reaches it.
func newFallbackTestServer(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	pilot := NewPilot(hub, st, svc, testAPIConfig(), nil)

	legacyMux := http.NewServeMux()
	legacyMux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("request fell through to the legacy transport")
		w.WriteHeader(http.StatusTeapot)
	})

	return pilot.FallbackHandler(legacyMux), st
}

// TestFallbackSSEAuthUnknownConnection covers a migrated operation answering a
// legitimate 404: FallbackHandler must replay the Huma response, not treat it
// as a route miss and fall through to the legacy mux.
func TestFallbackSSEAuthUnknownConnection(t *testing.T) {
	h, st := newFallbackTestServer(t)
	user := createTestUser(t, st)

	body := fmt.Sprintf(`{"connectionId":"missing-conn","token":%q}`, user.Token)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/sse-auth", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("error body not JSON: %v (body=%q)", err, rec.Body.String())
	}

	if resp["error"] != "connection not found" {
		t.Errorf("error = %v, want %q (body=%q)", resp["error"], "connection not found", rec.Body.String())
	}
}

// readSSEEvent reads one SSE frame ("event: X\ndata: Y") from the stream.
func readSSEEvent(t *testing.T, r *bufio.Reader) (string, string) {
	t.Helper()

	event := ""
	data := ""

	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("reading SSE stream: %v", err)
		}

		line = strings.TrimRight(line, "\n")

		switch {
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data = strings.TrimPrefix(line, "data: ")
		case line == "":
			if event != "" || data != "" {
				return event, data
			}
		}
	}
}

// TestFallbackSSEConnectAndAuth runs the real wire sequence: open the SSE
// stream, wait for connected, then authenticate the connection. Catches the
// register-after-connected race where sse-auth could 404 right after
// connected.
func TestFallbackSSEConnectAndAuth(t *testing.T) {
	h, st := newFallbackTestServer(t)
	user := createTestUser(t, st)

	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events?connectionId=full-scenario", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	event, data := readSSEEvent(t, bufio.NewReader(resp.Body))
	if event != "connected" {
		t.Fatalf("first SSE event = %q, want connected", event)
	}

	if data != `{"status":"ok"}` {
		t.Errorf("connected data = %q", data)
	}

	authBody := fmt.Sprintf(`{"connectionId":"full-scenario","token":%q}`, user.Token)
	authReq, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/api/auth/sse-auth", strings.NewReader(authBody))
	if err != nil {
		t.Fatal(err)
	}

	authReq.Header.Set("Content-Type", "application/json")
	authResp, err := http.DefaultClient.Do(authReq)
	if err != nil {
		t.Fatal(err)
	}
	defer authResp.Body.Close()

	if authResp.StatusCode != http.StatusOK {
		t.Fatalf("sse-auth: expected 200, got %d", authResp.StatusCode)
	}
}

// TestFallbackSSEPresenceCleanup verifies the deferred cleanup: after the SSE
// connection closes, the user's presence is removed from the store.
func TestFallbackSSEPresenceCleanup(t *testing.T) {
	h, st := newFallbackTestServer(t)
	user := createTestUser(t, st)

	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events?connectionId=cleanup-test", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	event, _ := readSSEEvent(t, bufio.NewReader(resp.Body))
	if event != "connected" {
		t.Fatalf("first SSE event = %q, want connected", event)
	}

	authBody := fmt.Sprintf(`{"connectionId":"cleanup-test","token":%q}`, user.Token)
	authReq, err := http.NewRequestWithContext(context.Background(), http.MethodPost, ts.URL+"/api/auth/sse-auth", strings.NewReader(authBody))
	if err != nil {
		t.Fatal(err)
	}

	authReq.Header.Set("Content-Type", "application/json")
	authResp, err := http.DefaultClient.Do(authReq)
	if err != nil {
		t.Fatal(err)
	}

	authResp.Body.Close()

	if authResp.StatusCode != http.StatusOK {
		t.Fatalf("sse-auth: expected 200, got %d", authResp.StatusCode)
	}

	if !st.IsOnline(user.ID) {
		t.Fatal("expected user to be online after sse-auth")
	}

	// Close the stream; the deferred cleanup must remove presence.
	cancel()
	resp.Body.Close()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !st.IsOnline(user.ID) {
			return
		}

		time.Sleep(10 * time.Millisecond)
	}

	t.Fatal("presence was not cleaned up after SSE connection closed")
}
