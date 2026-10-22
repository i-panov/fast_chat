package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"fast_chat/calls"
	"fast_chat/sse"
)

// recordedEvent is one event the service sent to the hub.
type recordedEvent struct {
	UserID string
	Event  sse.Event
}

// eventRecorder replaces the SSE hub in the tests: it records what the
// service sends.
type eventRecorder struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (r *eventRecorder) Send(userID string, event sse.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.events = append(r.events, recordedEvent{UserID: userID, Event: event})
}

func (r *eventRecorder) all() []recordedEvent {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]recordedEvent, len(r.events))
	copy(out, r.events)

	return out
}

func newCallService(t *testing.T) (*Service, *eventRecorder) {
	t.Helper()

	s := newFedTestService(t)

	recorder := &eventRecorder{}
	s.events = recorder
	s.SetCallManager(calls.NewManager(nil))

	return s, recorder
}

func createPrivateChat(t *testing.T, s *Service, alice, bob string) string {
	t.Helper()

	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice, bob, "")
	if err != nil {
		t.Fatal(err)
	}

	return chat.ID
}

func TestStartCallRejectsForeignCallee(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:remote.test")

	if _, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer"); !errors.Is(err, ErrRemoteCallee) {
		t.Fatalf("expected ErrRemoteCallee, got %v", err)
	}
}

func TestStartCallRejectsGroupChat(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	if _, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateGroupChat(ctx, "G", "alice:localhost:8080", []string{"bob:localhost:8080"}, "")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.StartCall(ctx, "alice:localhost:8080", chat.ID, "offer"); !errors.Is(err, ErrNotPrivateChat) {
		t.Fatalf("expected ErrNotPrivateChat, got %v", err)
	}
}

// The Favorites chat holds the user alone: a call there is a call to oneself.
func TestStartCallRejectsFavoritesChat(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.EnsureSelfChat(ctx, "alice:localhost:8080")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.StartCall(ctx, "alice:localhost:8080", chat.ID, "offer"); !errors.Is(err, ErrNotPrivateChat) {
		t.Fatalf("expected ErrNotPrivateChat, got %v", err)
	}
}

func TestStartCallRejectsCallerOutsideTheChat(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	if _, err := s.StartCall(ctx, "carol:localhost:8080", chatID, "offer"); !errors.Is(err, ErrNotParticipant) {
		t.Fatalf("expected ErrNotParticipant, got %v", err)
	}
}

func TestStartCallNotifiesTheCallee(t *testing.T) {
	s, recorder := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	if _, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer"); err != nil {
		t.Fatal(err)
	}

	events := recorder.all()
	found := false

	for _, e := range events {
		if e.Event.Event == "call_incoming" && e.UserID == "bob:localhost:8080" {
			found = true
		}
	}

	if !found {
		t.Fatalf("no call_incoming event: %+v", events)
	}
}

func TestAcceptCallSendsTheAnswerToTheCallerOnly(t *testing.T) {
	s, recorder := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.AcceptCall(ctx, "bob:localhost:8080", call.ID, "answer"); err != nil {
		t.Fatal(err)
	}

	withAnswer := 0
	withoutAnswer := 0

	for _, e := range recorder.all() {
		if e.Event.Event != "call_accepted" {
			continue
		}

		data, ok := e.Event.Data.(map[string]any)
		if !ok {
			continue
		}

		if data["answer"] != nil {
			withAnswer++

			continue
		}

		withoutAnswer++
	}

	if withAnswer != 1 || withoutAnswer != 1 {
		t.Fatalf("call_accepted with the answer: %d, without: %d", withAnswer, withoutAnswer)
	}
}

func TestAcceptCallRejectsAnotherUser(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.AcceptCall(ctx, "carol:localhost:8080", call.ID, "answer"); !errors.Is(err, ErrNotParticipant) {
		t.Fatalf("expected ErrNotParticipant, got %v", err)
	}
}

// The callee rejects the call: the caller is told that it was declined.
func TestRejectCallIsDoneByTheCallee(t *testing.T) {
	s, recorder := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.RejectCall(ctx, "alice:localhost:8080", call.ID); !errors.Is(err, ErrNotParticipant) {
		t.Fatalf("expected ErrNotParticipant for the caller, got %v", err)
	}

	if err := s.RejectCall(ctx, "bob:localhost:8080", call.ID); err != nil {
		t.Fatal(err)
	}

	rejected := 0

	for _, e := range recorder.all() {
		if e.Event.Event == "call_ended" {
			rejected++
		}
	}

	if rejected != 2 {
		t.Fatalf("call_ended events: %d, want 2", rejected)
	}
}

func TestHangupAcceptsOnlyPeerLeft(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.HangupCall(ctx, "alice:localhost:8080", call.ID, "rejected"); err != nil {
		t.Fatal(err)
	}

	stored, ok := s.CallManager().Get(call.ID)
	if !ok {
		t.Fatal("the call is gone")
	}

	if stored.Reason != calls.ReasonHangup {
		t.Fatalf("reason = %q, want %q", stored.Reason, calls.ReasonHangup)
	}
}

func TestHangupKeepsPeerLeft(t *testing.T) {
	s, _ := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.HangupCall(ctx, "alice:localhost:8080", call.ID, calls.ReasonPeerLeft); err != nil {
		t.Fatal(err)
	}

	stored, _ := s.CallManager().Get(call.ID)
	if stored.Reason != calls.ReasonPeerLeft {
		t.Fatalf("reason = %q, want %q", stored.Reason, calls.ReasonPeerLeft)
	}
}

func TestSendIceGoesToThePeer(t *testing.T) {
	s, recorder := newCallService(t)
	ctx := context.Background()

	chatID := createPrivateChat(t, s, "alice:localhost:8080", "bob:localhost:8080")

	call, err := s.StartCall(ctx, "alice:localhost:8080", chatID, "offer")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.SendIce(ctx, "alice:localhost:8080", call.ID, json.RawMessage(`{"candidate":"c"}`)); err != nil {
		t.Fatal(err)
	}

	for _, e := range recorder.all() {
		if e.Event.Event != "call_ice" || e.UserID != "bob:localhost:8080" {
			continue
		}

		data, ok := e.Event.Data.(map[string]any)
		if !ok {
			t.Fatalf("unexpected data: %+v", e.Event.Data)
		}

		raw, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}

		var payload struct {
			Candidate map[string]any `json:"candidate"`
		}

		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}

		if payload.Candidate["candidate"] != "c" {
			t.Fatalf("the candidate is not an object: %s", raw)
		}

		return
	}

	t.Fatalf("the candidate did not reach the peer: %+v", recorder.all())
}
