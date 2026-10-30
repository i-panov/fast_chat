package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"fast_chat/sse"
	"fast_chat/store"
)

func TestValidCoords(t *testing.T) {
	cases := []struct {
		lat, lng float64
		want     bool
	}{
		{0, 0, true},
		{90, 180, true},
		{-90, -180, true},
		{90.0001, 0, false},
		{0, 180.1, false},
		{-90.1, 0, false},
		{999, 999, false},
	}
	for _, c := range cases {
		if got := ValidCoords(c.lat, c.lng); got != c.want {
			t.Errorf("ValidCoords(%v,%v)=%v want %v", c.lat, c.lng, got, c.want)
		}
	}
}

func TestParseLocationPatch(t *testing.T) {
	// Empty -> no change.
	loc, changed, err := parseLocationPatch(nil)
	if err != nil || changed || loc != nil {
		t.Fatalf("empty: loc=%v changed=%v err=%v", loc, changed, err)
	}

	// "null" -> clear location.
	loc, changed, err = parseLocationPatch(json.RawMessage("null"))
	if err != nil || !changed || loc != nil {
		t.Fatalf("null: loc=%v changed=%v err=%v", loc, changed, err)
	}

	// Valid coords.
	loc, changed, err = parseLocationPatch(json.RawMessage(`{"lat":55.7,"lng":37.6}`))
	if err != nil || changed || loc == nil {
		t.Fatalf("valid: loc=%v changed=%v err=%v", loc, changed, err)
	}
	if loc.Lat != 55.7 || loc.Lng != 37.6 {
		t.Errorf("unexpected loc: %+v", loc)
	}

	// Invalid coords.
	if _, _, err := parseLocationPatch(json.RawMessage(`{"lat":999,"lng":37.6}`)); !errors.Is(err, ErrInvalidCoordinates) {
		t.Fatalf("bad coords: expected ErrInvalidCoordinates, got %v", err)
	}

	// Malformed JSON.
	if _, _, err := parseLocationPatch(json.RawMessage(`{bad`)); !errors.Is(err, ErrInvalidCoordinates) {
		t.Fatalf("malformed: expected ErrInvalidCoordinates, got %v", err)
	}

	// Explicit nulls decode to zero without an error from encoding/json,
	// which would pin the message to (0,0).
	for _, raw := range []string{
		`{"lat":null,"lng":37.6}`,
		`{"lat":55.7,"lng":null}`,
		`{"lat":null,"lng":null}`,
	} {
		if _, _, err := parseLocationPatch(json.RawMessage(raw)); !errors.Is(err, ErrInvalidCoordinates) {
			t.Fatalf("%s: expected ErrInvalidCoordinates, got %v", raw, err)
		}
	}
}

// newHubbedTestService returns a service with a live SSE hub so a test can
// observe what the fan-out actually published.
func newHubbedTestService(t *testing.T) (*Service, *sse.Hub) {
	t.Helper()

	svc := newTestService(t)
	hub := sse.NewHub(time.Minute)

	t.Cleanup(hub.Close)

	svc.hub = hub
	svc.events = hub

	return svc, hub
}

// subscribe registers an authorized SSE connection for userID and returns the
// channel its events arrive on.
func subscribe(t *testing.T, hub *sse.Hub, userID string) chan sse.Event {
	t.Helper()

	connID := "conn-" + userID
	hub.Register(connID)

	if err := hub.Authenticate(connID, userID, "token", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("Authenticate(%s): %v", userID, err)
	}

	return hub.GetConnection(connID).Channel
}

// drain returns the queued event names, skipping the delivery receipts that
// SendMessage emits after the new_message fan-out.
func drainEvents(events chan sse.Event) []string {
	var names []string

	for {
		select {
		case evt := <-events:
			if evt.Event != eventMessageDelivered {
				names = append(names, evt.Event)
			}
		default:
			return names
		}
	}
}

// TestSendMessageRetryDoesNotResendOrFabricate covers the retried send from the
// offline outbox, which reuses the id the client already has. The insert hits
// the primary key, so the row that exists is what the caller must get back: the
// old code answered 201 with the attempt and broadcast that attempt, so the
// members saw text that was never stored and got it again on every retry.
func TestSendMessageRetryDoesNotResendOrFabricate(t *testing.T) {
	svc, hub := newHubbedTestService(t)

	ctx := context.Background()
	alice := "alice:test"
	bob := "bob:test"

	for _, nick := range []string{"alice", "bob"} {
		if _, err := svc.store.CreateUser(ctx, nick+"@example.com", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := svc.store.CreateChat(ctx, alice, bob, "")
	if err != nil {
		t.Fatal(err)
	}

	bobEvents := subscribe(t, hub, bob)

	const original = "the original text"

	if _, err := svc.SendMessage(ctx, chat, "", alice, "alice", &SendMessageInput{ID: "msg-1", Text: original}); err != nil {
		t.Fatalf("first SendMessage: %v", err)
	}

	if got := drainEvents(bobEvents); len(got) != 1 {
		t.Fatalf("expected one new_message event, got %v", got)
	}

	// Retry the same id with different text: what an outbox that was flushed
	// from a stale local copy looks like.
	second, err := svc.SendMessage(ctx, chat, "", alice, "alice", &SendMessageInput{ID: "msg-1", Text: "REPLACED text"})
	if err != nil {
		t.Fatalf("retry SendMessage: %v", err)
	}

	if second.Text != original {
		t.Errorf("retry answered with unattached text %q; stored row is %q", second.Text, original)
	}

	if got := drainEvents(bobEvents); len(got) != 0 {
		t.Errorf("retry re-broadcast %v; members already received this message", got)
	}

	stored, err := svc.store.GetMessage(ctx, chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	if stored.Text != original {
		t.Errorf("stored text = %q, want %q", stored.Text, original)
	}
}

// TestSendMessageRejectsIDUsedByAnotherChat covers the id being a table-wide
// primary key rather than a per-chat one. A collision with a message in a
// different chat must be refused, not answered with that other message.
func TestSendMessageRejectsIDUsedByAnotherChat(t *testing.T) {
	svc, _ := newHubbedTestService(t)

	ctx := context.Background()
	alice := "alice:test"
	bob := "bob:test"
	carol := "carol:test"

	for _, nick := range []string{"alice", "bob", "carol"} {
		if _, err := svc.store.CreateUser(ctx, nick+"@example.com", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chatOne, err := svc.store.CreateChat(ctx, alice, bob, "")
	if err != nil {
		t.Fatal(err)
	}

	chatTwo, err := svc.store.CreateChat(ctx, alice, carol, "")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.SendMessage(ctx, chatOne, "", alice, "alice", &SendMessageInput{ID: "shared-id", Text: "in chat one"}); err != nil {
		t.Fatal(err)
	}

	_, err = svc.SendMessage(ctx, chatTwo, "", alice, "alice", &SendMessageInput{ID: "shared-id", Text: "in chat two"})
	if !errors.Is(err, store.ErrMessageIDConflict) {
		t.Fatalf("err = %v, want store.ErrMessageIDConflict", err)
	}
}
