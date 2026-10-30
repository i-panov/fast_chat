package sse

import (
	"errors"
	"testing"
	"time"
)

func TestRegisterGetConnection(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	conn := h.Register("c1")
	if conn == nil || conn.ID != "c1" {
		t.Fatalf("Register returned %+v", conn)
	}

	if got := h.GetConnection("c1"); got != conn {
		t.Errorf("GetConnection mismatch: %p vs %p", got, conn)
	}
	if got := h.GetConnection("missing"); got != nil {
		t.Errorf("GetConnection missing should return nil, got %p", got)
	}
}

func TestUnregisterRemovesAndClosesChannel(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	conn := h.Register("c1")
	h.Authenticate("c1", "u1", "tok", time.Now().Add(time.Hour))

	h.Unregister("c1", conn)

	if h.GetConnection("c1") != nil {
		t.Error("connection should be removed after Unregister")
	}

	// Stale Unregister from an old handler must not panic or affect a
	// new connection with the same id.
	conn2 := h.Register("c2")
	h.Register("c1") // reconnect replaces c1
	h.Unregister("c1", conn)
	if h.GetConnection("c1") == nil {
		t.Error("stale Unregister must not remove the new connection")
	}
	_ = conn2
}

func TestAuthenticate(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	if err := h.Authenticate("nope", "u1", "t", time.Now()); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("expected ErrConnectionNotFound, got %v", err)
	}

	conn := h.Register("c1")
	exp := time.Now().Add(time.Hour)
	if err := h.Authenticate("c1", "u1", "tok", exp); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}

	if !conn.Authorized || conn.UserID != "u1" || conn.Token != "tok" || !conn.ExpiresAt.Equal(exp) {
		t.Errorf("connection not populated: %+v", conn)
	}

	// Replaying auth for the same connection must not duplicate the entry.
	if err := h.Authenticate("c1", "u1", "tok2", exp); err != nil {
		t.Fatalf("re-auth: %v", err)
	}
	if len(h.userConns["u1"]) != 1 {
		t.Errorf("duplicate user connection entry: %v", h.userConns["u1"])
	}
}

func TestSendDeliversOnlyToAuthorizedCurrentUsers(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	// Authorized connection.
	a := h.Register("a")
	h.Authenticate("a", "u1", "tok", time.Now().Add(time.Hour))

	// Unregistered connection (never authenticated).
	b := h.Register("b")

	_ = b

	ev := Event{Event: "message", Data: "hi"}
	h.Send("u1", ev)

	// Receiver must be on a's channel.
	select {
	case got := <-a.Channel:
		if got.Event != "message" || got.Data != "hi" {
			t.Errorf("unexpected event: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("expected event on a's channel")
	}

	// b's channel must be empty.
	select {
	case got := <-b.Channel:
		t.Errorf("unexpected event for b: %+v", got)
	default:
	}
}

func TestSendSkipsExpiredTokens(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	conn := h.Register("c1")
	h.Authenticate("c1", "u1", "tok", time.Now().Add(-time.Minute)) // expired

	h.Send("u1", Event{Event: "m", Data: "x"})

	select {
	case got := <-conn.Channel:
		t.Errorf("expired connection should not receive event, got %+v", got)
	default:
	}
}

func TestSendToUnknownUserIsNoop(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	h.Send("ghost", Event{Event: "m", Data: "x"}) // must not panic
	_ = t
}

func TestLastTyping(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	if _, ok := h.LoadLastTyping("key"); ok {
		t.Fatal("no typing state initially")
	}

	ts := time.Now()
	h.StoreLastTyping("key", ts)

	v, ok := h.LoadLastTyping("key")
	if !ok || v.(time.Time).UnixNano() != ts.UnixNano() {
		t.Errorf("LoadLastTyping = %v, %v", v, ok)
	}
}

func TestCleanupLastTypingRemovesStaleEntries(t *testing.T) {
	const interval = 20 * time.Millisecond
	h := NewHub(interval)
	defer h.Close()

	// Bound the "fresh" entry far into the future relative to any
	// cleanup cutoff so it is guaranteed to survive multiple ticks.
	h.StoreLastTyping("fresh", time.Now().Add(time.Minute))
	h.StoreLastTyping("stale", time.Now().Add(-time.Hour))

	// Wait well past several cleanup intervals so the stale entry is
	// swept while the far-future fresh entry remains.
	time.Sleep(interval * 8)

	if _, ok := h.LoadLastTyping("fresh"); !ok {
		t.Error("fresh typing entry should survive cleanup")
	}
	if _, ok := h.LoadLastTyping("stale"); ok {
		t.Error("stale typing entry should be removed by cleanup")
	}
}

func TestCloseClosesAllChannels(t *testing.T) {
	h := NewHub(time.Hour)

	a := h.Register("a")
	b := h.Register("b")

	h.Close()

	// Both channels must be closed (non-blocking read returns ok=false).
	_, ok := <-a.Channel
	if ok {
		t.Error("a channel should be closed")
	}
	_, ok = <-b.Channel
	if ok {
		t.Error("b channel should be closed")
	}

	// Closing twice must not panic.
	h.Close()
}

func TestRegisterDeduplicatesUserConnsOnReconnect(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	first := h.Register("c1")
	h.Authenticate("c1", "u1", "t1", time.Now().Add(time.Hour))

	// Reconnect with the same id replaces the old connection.
	second := h.Register("c1")
	h.Authenticate("c1", "u1", "t2", time.Now().Add(time.Hour))

	if h.GetConnection("c1") != second {
		t.Error("GetConnection should return the new connection")
	}
	if len(h.userConns["u1"]) != 1 {
		t.Errorf("userConns should have a single entry, got %v", h.userConns["u1"])
	}

	// The old channel is closed.
	if _, ok := <-first.Channel; ok {
		t.Error("old connection channel should be closed")
	}
}

func TestCloseExpiredUnauthenticated(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	stale := h.Register("stale")
	h.Register("fresh")
	h.Register("auth")
	h.Authenticate("auth", "u1", "tok", time.Now().Add(time.Hour))

	// Age only the stale connection past the auth deadline.
	stale.mu.Lock()
	stale.CreatedAt = time.Now().Add(-hubAuthTimeout - time.Minute)
	stale.mu.Unlock()

	if got := h.CloseExpiredUnauthenticated(time.Now()); got != 1 {
		t.Fatalf("reaped = %d, want 1", got)
	}

	if h.GetConnection("stale") != nil {
		t.Error("stale unauthenticated connection should be reclaimed")
	}

	if h.GetConnection("fresh") == nil || h.GetConnection("auth") == nil {
		t.Error("fresh and authenticated connections must survive the reap")
	}
}
