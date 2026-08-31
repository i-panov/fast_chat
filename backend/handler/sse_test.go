package handler

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"fast_chat/sse"
)

// flushRecorder is a thread-safe http.ResponseWriter that also implements
// http.Flusher so it can back streaming handlers while the test observes the
// output from another goroutine.
type flushRecorder struct {
	mu      sync.Mutex
	header  http.Header
	body    bytes.Buffer
	flushed bool
}

func newFlushRecorder() *flushRecorder {
	return &flushRecorder{header: http.Header{}}
}

func (f *flushRecorder) Header() http.Header {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.header
}

func (f *flushRecorder) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.body.Write(p)
}

func (f *flushRecorder) WriteHeader(httpCode int) {}

func (f *flushRecorder) Flush() {
	f.mu.Lock()
	f.flushed = true
	f.mu.Unlock()
}

func (f *flushRecorder) Flushed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.flushed
}

func (f *flushRecorder) String() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.body.String()
}

func (f *flushRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, http.ErrNotSupported
}

func TestSSERequiresConnectionID(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	req := authReq(http.MethodGet, "/api/sse", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SSE)(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSSEConnectionAndEventFlow(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/sse?connectionId=c1", nil)
	req.Header.Set("Authorization", "Bearer "+alice.token)
	rec := newFlushRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.SSE(rec, req)
	}()

	// Wait for the connected handshake to be flushed.
	deadline := time.Now().Add(2 * time.Second)
	for !rec.Flushed() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	if !strings.Contains(rec.String(), "event: connected") {
		t.Fatalf("expected connected handshake, got: %q", rec.String())
	}

	// Authenticate the SSE connection through the hub.
	if err := h.hub.Authenticate("c1", alice.id, "t", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("authenticate: %v", err)
	}

	// Send an event to the user; it should arrive on the stream.
	h.hub.Send(alice.id, sse.Event{Event: "message", Data: map[string]string{"m": "x"}})

	// Wait for the event to be written.
	eventDeadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(rec.String(), "event: message") && time.Now().Before(eventDeadline) {
		time.Sleep(5 * time.Millisecond)
	}

	if !strings.Contains(rec.String(), "event: message") {
		t.Fatalf("expected message event on stream, got: %q", rec.String())
	}
	if !strings.Contains(rec.String(), `"m":"x"`) {
		t.Fatalf("expected message payload, got: %q", rec.String())
	}

	cancel()
	<-done
}

func TestSSEUnauthorizedConnectsWithoutEvents(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/sse?connectionId=c2", nil)
	req.Header.Set("Authorization", "Bearer "+alice.token)
	rec := newFlushRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.SSE(rec, req)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for !rec.Flushed() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	// This connection has never been authenticated: it must not receive events.
	h.hub.Send(alice.id, sse.Event{Event: "message", Data: map[string]string{"m": "x"}})

	time.Sleep(50 * time.Millisecond)
	afterSend := rec.String()
	if strings.Contains(afterSend, "event: message") {
		t.Fatalf("unauthorized connection received message event: %q", afterSend)
	}

	cancel()
	<-done
}
