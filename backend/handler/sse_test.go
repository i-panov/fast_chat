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

func TestSSEHubSubscribeSend(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	ch := hub.Subscribe("user-1")
	hub.Send("user-1", SSEEvent{Event: "test", Data: "hello"})

	select {
	case e := <-ch:
		if e.Event != "test" {
			t.Fatalf("event = %q, want test", e.Event)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event")
	}
}

func TestSSEHubUnsubscribeClosesChannel(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	ch := hub.Subscribe("user-1")
	hub.Unsubscribe("user-1", ch)

	if _, ok := <-ch; ok {
		t.Fatal("channel should be closed after Unsubscribe")
	}

	if _, exists := hub.clients["user-1"]; exists {
		t.Fatal("user entry should be removed when last subscriber leaves")
	}
}

func TestSSEHubChannelFullDoesNotPanic(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	ch := hub.Subscribe("user-1")

	// Fill the buffer (sseChannelBuffer = 128). One extra Send must
	// not block and must not panic.
	_ = ch

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
}

func TestSSEHubSendToMissingUserIsNoop(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	hub.Send("nobody", SSEEvent{Event: "noop", Data: "x"})
}

func TestSSEHubMultipleSubscribers(t *testing.T) {
	t.Parallel()

	hub := newTestSSEHub()
	defer hub.Close()

	ch1 := hub.Subscribe("user-1")
	ch2 := hub.Subscribe("user-1")

	hub.Send("user-1", SSEEvent{Event: "fanout", Data: "y"})

	for i, ch := range []chan SSEEvent{ch1, ch2} {
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

func TestSSEHubLastTypingCleanup(t *testing.T) {
	t.Parallel()

	hub := &SSEHub{
		clients: make(map[string][]chan SSEEvent),
		closeCh: make(chan struct{}),
	}

	hub.lastTyping.Store("chat1:user1", time.Now().Add(-typingThrottleInterval*10))
	hub.lastTyping.Store("chat2:user1", time.Now())

	// Drive one iteration of the cleanup loop inline; we don't want
	// the background ticker for a deterministic test.
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
