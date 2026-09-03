package transport

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
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

func newTransportTestServer(t *testing.T) *Transport {
	t.Helper()

	return newTransportTestServerWithRL(t, nil)
}

// newTransportTestServerWithRL builds a transport wired with the given rate
// limiters (nil disables the per-route middleware).
func newTransportTestServerWithRL(t *testing.T, rl *RateLimiters) *Transport {
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

	return New(&Deps{Hub: hub, Store: st, Svc: svc, Cfg: cfg, RateLimiters: rl})
}

func TestTransportSSEConnected(t *testing.T) {
	transport := newTransportTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events?connectionId=test-conn-1", http.NoBody)
	rec := httptest.NewRecorder()

	// Use a context with timeout so the test doesn't hang on the endless loop.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)

	transport.Handler().ServeHTTP(rec, req)

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

func TestTransportSSEMissingConnectionID(t *testing.T) {
	transport := newTransportTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events", http.NoBody)
	rec := httptest.NewRecorder()

	transport.Handler().ServeHTTP(rec, req)

	// Missing connectionId returns 400 to match legacy behavior.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestTransportSSEStreamStaysOpen(t *testing.T) {
	transport := newTransportTestServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events?connectionId=open-test", http.NoBody).WithContext(ctx)
	rec := httptest.NewRecorder()

	transport.Handler().ServeHTTP(rec, req)

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
	transport := newTransportTestServerWithRL(t, rl)
	t.Cleanup(func() { rl.SendCode.Close() })

	body := `{"email":"test@example.com"}`

	for i := range 2 {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		transport.Handler().ServeHTTP(rec, req)

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
	transport := newTransportTestServer(t)

	// Oversized body (> Huma's built-in 1MB MaxBodyBytes) is rejected before
	// it can reach the service. Huma answers 413 (legacy: 400).
	big := strings.Repeat("a", 2<<20)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"`+big+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	transport.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", rec.Code)
	}
}

// newFallbackTestServer wires the transport behind FallbackHandler over a
// legacy mux that fails the test if a migrated route ever reaches it.
func newFallbackTestServer(t *testing.T) (http.Handler, *store.Store, *sse.Hub) {
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	cfg := testAPIConfig()
	cfg.Uploads = config.UploadsConfig{Dir: t.TempDir()}
	svc := newTestService(st, hub)
	transport := New(&Deps{Hub: hub, Store: st, Svc: svc, Cfg: cfg})

	legacyMux := http.NewServeMux()
	legacyMux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("request fell through to the legacy transport")
		w.WriteHeader(http.StatusTeapot)
	})

	return transport.FallbackHandler(legacyMux), st, hub
}

// TestFallbackSSEAuthUnknownConnection covers a migrated operation answering a
// legitimate 404: FallbackHandler must replay the Huma response, not treat it
// as a route miss and fall through to the legacy mux.
func TestFallbackSSEAuthUnknownConnection(t *testing.T) {
	h, st, _ := newFallbackTestServer(t)
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
	h, st, _ := newFallbackTestServer(t)
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
	h, st, _ := newFallbackTestServer(t)
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

// TestFallbackSSEAuthInvalidToken mirrors the legacy "invalid token is
// unauthorized" case for the migrated sse-auth operation.
func TestFallbackSSEAuthInvalidToken(t *testing.T) {
	h, _, _ := newFallbackTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/sse-auth", strings.NewReader(`{"connectionId":"c1","token":"bogus"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestFallbackSSEEventFlow verifies the full event pipeline on the wire:
// connected → sse-auth → hub event delivered to the authenticated stream.
func TestFallbackSSEEventFlow(t *testing.T) {
	h, st, hub := newFallbackTestServer(t)
	user := createTestUser(t, st)

	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events?connectionId=flow-conn", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)

	event, _ := readSSEEvent(t, reader)
	if event != "connected" {
		t.Fatalf("first SSE event = %q, want connected", event)
	}

	authBody := fmt.Sprintf(`{"connectionId":"flow-conn","token":%q}`, user.Token)
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

	hub.Send(user.ID, sse.Event{Event: "message", Data: map[string]string{"m": "x"}})

	deadline := time.Now().Add(2 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("expected message event on stream, got nothing; connected block seen so far")
		}

		var data string

		event, data = readSSEEvent(t, reader)
		if event == "message" {
			if data != `{"m":"x"}` {
				t.Errorf("message data = %q", data)
			}

			return
		}
	}
}

// TestFallbackSSEUnauthorizedNoEvents mirrors the legacy guarantee: a
// connection that never called sse-auth must not receive hub events.
func TestFallbackSSEUnauthorizedNoEvents(t *testing.T) {
	h, st, hub := newFallbackTestServer(t)
	user := createTestUser(t, st)

	ts := httptest.NewServer(h)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events?connectionId=noauth-conn", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)

	event, _ := readSSEEvent(t, reader)
	if event != "connected" {
		t.Fatalf("first SSE event = %q, want connected", event)
	}

	hub.Send(user.ID, sse.Event{Event: "message", Data: map[string]string{"m": "x"}})

	// The stream must stay silent: heartbeats only start after 30s and the
	// connection is unauthorized, so the next read blocks unless a hub event
	// arrives.
	done := make(chan struct{})
	go func() {
		defer close(done)

		_, _ = reader.ReadString('\n') // blocks unless an event arrives
	}()

	select {
	case <-done:
		t.Fatal("unauthorized connection received an event")
	case <-time.After(400 * time.Millisecond):
	}
}

// recordingWriter is a minimal http.ResponseWriter/Flusher that records what
// reaches the real transport.
type recordingWriter struct {
	header   http.Header
	body     bytes.Buffer
	status   int
	flushed  bool
	wroteHdr bool
}

func newRecordingWriter() *recordingWriter {
	return &recordingWriter{header: make(http.Header)}
}

func (r *recordingWriter) Header() http.Header { return r.header }

func (r *recordingWriter) Write(p []byte) (int, error) {
	if !r.wroteHdr {
		r.wroteHdr = true
		if r.status == 0 {
			r.status = http.StatusOK
		}
	}

	return r.body.Write(p)
}

func (r *recordingWriter) WriteHeader(code int) {
	if r.wroteHdr {
		return
	}

	r.wroteHdr = true
	r.status = code
}

func (r *recordingWriter) Flush() { r.flushed = true }

func TestFallbackBufferStreamsThrough(t *testing.T) {
	// A matched streaming response must reach the underlying writer as soon as
	// it begins; the buffer must not accumulate the body.
	underlying := newRecordingWriter()
	buf := newFallbackBuffer(underlying)

	buf.Header().Set("Content-Type", "text/event-stream")
	buf.WriteHeader(http.StatusOK)

	if !buf.passthrough {
		t.Fatal("expected pass-through mode after WriteHeader on a matched response")
	}

	if _, err := buf.Write([]byte("event: connected\n\n")); err != nil {
		t.Fatal(err)
	}

	buf.Flush()

	if !underlying.flushed {
		t.Fatal("expected Flush to be forwarded to the underlying writer")
	}

	if got := underlying.body.String(); got != "event: connected\n\n" {
		t.Fatalf("underlying body = %q, want the streamed chunk", got)
	}

	if underlying.status != http.StatusOK {
		t.Fatalf("underlying status = %d, want 200", underlying.status)
	}

	// Subsequent writes keep flowing straight through.
	if _, err := buf.Write([]byte(": heartbeat\n\n")); err != nil {
		t.Fatal(err)
	}

	if got := underlying.body.String(); got != "event: connected\n\n: heartbeat\n\n" {
		t.Fatalf("underlying body = %q", got)
	}
}

func TestFallbackBufferKeepsMissBuffered(t *testing.T) {
	// A route-miss response (marker header) stays buffered so nothing reaches
	// the underlying writer before the legacy transport takes over.
	underlying := newRecordingWriter()
	buf := newFallbackBuffer(underlying)

	buf.Header().Set(routeMissHeader, "1")
	buf.WriteHeader(http.StatusNotFound)
	_, _ = buf.Write([]byte("404 page not found"))

	if !buf.miss {
		t.Fatal("expected miss detection via marker header")
	}

	if underlying.body.Len() != 0 || underlying.status != 0 {
		t.Fatalf("underlying writer was touched: status=%d body=%q", underlying.status, underlying.body.String())
	}
}

func TestFallbackFileDownloadStreams(t *testing.T) {
	// End-to-end through FallbackHandler: a multi-MB file must download
	// byte-identically (correctness of the streaming pass-through on real
	// transport).
	h, st, _ := newFallbackTestServer(t)
	alice := createTestUser(t, st)

	bob, err := st.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	// Create chat and upload a 3 MiB file.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token, `{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for chat, got %d: %s", rec.Code, rec.Body.String())
	}

	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	payload := make([]byte, 3<<20)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	var bodyBuf bytes.Buffer
	writer := multipart.NewWriter(&bodyBuf)

	part, err := writer.CreateFormFile("file", "big.bin")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}

	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/files/upload", &bodyBuf)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+alice.Token)

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for upload, got %d: %s", rec.Code, rec.Body.String())
	}

	fileID, _ := decodeBody(t, rec)["file"].(map[string]any)["id"].(string)
	if fileID == "" {
		t.Fatal("expected file id")
	}

	// Attach the file to a message so it becomes downloadable.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token,
		`{"id":"big-msg","text":"big file","fileIDs":["`+fileID+`"]}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for message, got %d: %s", rec.Code, rec.Body.String())
	}

	// Download through the fallback chain and verify byte identity.
	dl := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/files/"+fileID, http.NoBody)
	dl.Header.Set("Authorization", "Bearer "+alice.Token)

	dlRec := httptest.NewRecorder()
	h.ServeHTTP(dlRec, dl)

	if dlRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for download, got %d: %s", dlRec.Code, dlRec.Body.String())
	}

	if got := dlRec.Body.Bytes(); !bytes.Equal(got, payload) {
		t.Fatalf("downloaded %d bytes, want %d identical bytes", len(got), len(payload))
	}
}
