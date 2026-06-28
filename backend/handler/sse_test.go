package handler

import (
	"testing"
	"time"
)

func newTestSSEHub() *SSEHub {
	hub := NewSSEHub()

	// The cleanup ticker runs every 2s; tests don't need it and
	// we want a clean shutdown.
	hub.Close()

	return hub
}

func TestSSEHubRegisterSend(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))
	hub.Send("user-1", SSEEvent{Event: "test", Data: "hello"})

	select {
	case e := <-conn.Channel:
		if e.Event != "test" {
			t.Fatalf("event = %q, want test", e.Event)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event")
	}
}

func TestSSEHubUnregisterClosesChannel(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))
	hub.Unregister("conn-1")

	if _, ok := <-conn.Channel; ok {
		t.Fatal("channel should be closed after Unregister")
	}
}

func TestSSEHubChannelFullDoesNotPanic(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	// Fill the buffer (sseChannelBuffer = 128). One extra Send must
	// not block and must not panic.
	for i := range sseChannelBuffer {
		hub.Send("user-1", SSEEvent{Event: "flood", Data: i})
	}

	done := make(chan struct{})
	go func() {
		hub.Send("user-1", SSEEvent{Event: "overflow", Data: "dropped"})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Send blocked on full channel — must drop, not block")
	}

	// Drain the buffer so we have a clean state for the next assertion.
	for range sseChannelBuffer {
		<-conn.Channel
	}
}

func TestSSEHubSendToMissingUserIsNoop(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	hub.Send("nobody", SSEEvent{Event: "noop", Data: "x"})
}

func TestSSEHubMultipleConnections(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn1 := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	conn2 := hub.Register("conn-2")
	hub.Authenticate("conn-2", "user-1", "token-2", time.Now().Add(time.Hour))

	hub.Send("user-1", SSEEvent{Event: "fanout", Data: "y"})

	for i, ch := range []chan SSEEvent{conn1.Channel, conn2.Channel} {
		select {
		case e := <-ch:
			if e.Event != "fanout" {
				t.Fatalf("ch%d: event = %q, want fanout", i+1, e.Event)
			}
		case <-time.After(100 * time.Millisecond):
			t.Fatalf("ch%d: timeout waiting for event", i+1)
		}
	}
}

func TestSSEHubReRegisterReplacesChannel(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	oldConn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	newConn := hub.Register("conn-1")

	// Old channel must be closed.
	if _, ok := <-oldConn.Channel; ok {
		t.Fatal("old channel should be closed after re-register")
	}

	// New connection is not yet authorized; after re-register,
	// Authenticate must be called again.
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))
	hub.Send("user-1", SSEEvent{Event: "reconnect", Data: "ok"})

	select {
	case e := <-newConn.Channel:
		if e.Event != "reconnect" {
			t.Fatalf("event = %q, want reconnect", e.Event)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event on new channel")
	}
}

func TestSSEHubExpiredToken(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(-time.Hour))

	hub.Send("user-1", SSEEvent{Event: "should-not-arrive", Data: "x"})

	select {
	case <-conn.Channel:
		t.Fatal("should not receive event on expired connection")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSSEHubUnauthenticatedUserIsNoop(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	// Not authenticated.

	hub.Send("user-1", SSEEvent{Event: "should-not-arrive", Data: "x"})

	select {
	case <-conn.Channel:
		t.Fatal("should not receive event on unauthenticated connection")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSSEHubLastTypingCleanup(t *testing.T) {
	t.Parallel()

	hub := &SSEHub{
		connections: make(map[string]*SSEConnection),
		userConns:   make(map[string][]string),
		closeCh:     make(chan struct{}),
	}

	hub.lastTyping.Store("chat1:user1", time.Now().Add(-typingThrottleInterval*10))
	hub.lastTyping.Store("chat2:user1", time.Now())

	cutoff := time.Now().Add(-typingThrottleInterval * 5)

	hub.lastTyping.Range(func(k, v any) bool {
		ts, ok := v.(time.Time)
		if !ok || ts.Before(cutoff) {
			hub.lastTyping.Delete(k)
		}

		return true
	})

	if _, present := hub.lastTyping.Load("chat1:user1"); present {
		t.Fatal("stale entry should be cleaned up")
	}

	if _, present := hub.lastTyping.Load("chat2:user1"); !present {
		t.Fatal("fresh entry should be kept")
	}
}
