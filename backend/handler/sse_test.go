package handler

import (
	"testing"
	"time"

	"fast_chat/sse"
)

func newTestSSEHub() *sse.Hub {
	hub := sse.NewHub(typingThrottleInterval * 5)

	hub.Close()

	return hub
}

func TestSSEHubRegisterSend(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))
	hub.Send("user-1", sse.Event{Event: "test", Data: "hello"})

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
	hub.Unregister("conn-1", conn)

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

	for range 128 {
		hub.Send("user-1", sse.Event{Event: "flood", Data: 0})
	}

	done := make(chan struct{})
	go func() {
		hub.Send("user-1", sse.Event{Event: "overflow", Data: "dropped"})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Send blocked on full channel — must drop, not block")
	}

	for range 128 {
		<-conn.Channel
	}
}

func TestSSEHubSendToMissingUserIsNoop(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	hub.Send("nobody", sse.Event{Event: "noop", Data: "x"})
}

func TestSSEHubMultipleConnections(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn1 := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	conn2 := hub.Register("conn-2")
	hub.Authenticate("conn-2", "user-1", "token-2", time.Now().Add(time.Hour))

	hub.Send("user-1", sse.Event{Event: "fanout", Data: "y"})

	for i, ch := range []chan sse.Event{conn1.Channel, conn2.Channel} {
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

	if _, ok := <-oldConn.Channel; ok {
		t.Fatal("old channel should be closed after re-register")
	}

	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))
	hub.Send("user-1", sse.Event{Event: "reconnect", Data: "ok"})

	select {
	case e := <-newConn.Channel:
		if e.Event != "reconnect" {
			t.Fatalf("event = %q, want reconnect", e.Event)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event on new channel")
	}
}

func TestSSEHubUnregisterStaleConnectionIsNoop(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	oldConn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	// Reconnect reuses the same connectionID and replaces the entry.
	newConn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(time.Hour))

	// The old handler's deferred Unregister must not close the new channel.
	hub.Unregister("conn-1", oldConn)

	hub.Send("user-1", sse.Event{Event: "still-alive", Data: "ok"})

	select {
	case e := <-newConn.Channel:
		if e.Event != "still-alive" {
			t.Fatalf("event = %q, want still-alive", e.Event)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("new connection was closed by stale Unregister")
	}
}

func TestSSEHubExpiredToken(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	conn := hub.Register("conn-1")
	hub.Authenticate("conn-1", "user-1", "token-1", time.Now().Add(-time.Hour))

	hub.Send("user-1", sse.Event{Event: "should-not-arrive", Data: "x"})

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

	hub.Send("user-1", sse.Event{Event: "should-not-arrive", Data: "x"})

	select {
	case <-conn.Channel:
		t.Fatal("should not receive event on unauthenticated connection")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSSEHubLastTypingCleanup(t *testing.T) {
	t.Parallel()

	shortInterval := 50 * time.Millisecond
	hub := sse.NewHub(shortInterval)
	defer hub.Close()

	hub.StoreLastTyping("chat1:user1", time.Now().Add(-shortInterval*10))

	time.Sleep(shortInterval * 3)

	if _, present := hub.LoadLastTyping("chat1:user1"); present {
		t.Fatal("stale entry should be cleaned up")
	}

	hub.StoreLastTyping("chat2:user1", time.Now())

	if _, present := hub.LoadLastTyping("chat2:user1"); !present {
		t.Fatal("fresh entry should be present")
	}
}
