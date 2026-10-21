package calls

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func testManager(now func() time.Time) *Manager {
	m := NewManager(func(string) bool { return true })
	m.now = now

	return m
}

func TestCreateCallRejectsBusyUsers(t *testing.T) {
	m := testManager(time.Now)

	if _, err := m.CreateCall("alice", "bob", "chat-1", "offer"); err != nil {
		t.Fatal(err)
	}

	if _, err := m.CreateCall("carol", "bob", "chat-2", "offer"); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy, got %v", err)
	}

	if _, err := m.CreateCall("alice", "carol", "chat-3", "offer"); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected ErrBusy for the busy caller, got %v", err)
	}
}

func TestAcceptCallIsAtomic(t *testing.T) {
	m := testManager(time.Now)

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.AcceptCall(call.ID, "answer"); err != nil {
		t.Fatal(err)
	}

	if _, err := m.AcceptCall(call.ID, "answer"); !errors.Is(err, ErrNotRinging) {
		t.Fatalf("expected ErrNotRinging, got %v", err)
	}
}

func TestEndCallClearsTheOffer(t *testing.T) {
	m := testManager(time.Now)

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.EndCall(call.ID, ReasonHangup); err != nil {
		t.Fatal(err)
	}

	stored, ok := m.Get(call.ID)
	if !ok {
		t.Fatal("the call is gone")
	}

	if stored.Offer != "" || stored.Answer != "" {
		t.Fatalf("the SDP was not cleared: %+v", stored)
	}

	if stored.Reason != ReasonHangup {
		t.Fatalf("reason = %q", stored.Reason)
	}
}

func TestCurrentReturnsTheLastEndedCall(t *testing.T) {
	m := testManager(time.Now)

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.EndCall(call.ID, ReasonTimeout); err != nil {
		t.Fatal(err)
	}

	current, ok := m.Current("bob")
	if !ok {
		t.Fatal("expected the ended call")
	}

	if current.Reason != ReasonTimeout {
		t.Fatalf("reason = %q", current.Reason)
	}
}

func TestSweepEndsCallsWithoutParticipants(t *testing.T) {
	now := time.Now()
	m := NewManager(func(string) bool { return false })
	m.now = func() time.Time { return now }

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.AcceptCall(call.ID, "answer"); err != nil {
		t.Fatal(err)
	}

	m.Sweep()

	stored, ok := m.Get(call.ID)
	if !ok {
		t.Fatal("the call is gone")
	}

	if stored.State != StateEnded {
		t.Fatalf("state = %q, want ended", stored.State)
	}
}

func TestSweepKeepsCallsWithAParticipant(t *testing.T) {
	now := time.Now()
	online := map[string]bool{"bob": true}
	m := NewManager(func(userID string) bool { return online[userID] })
	m.now = func() time.Time { return now }

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.AcceptCall(call.ID, "answer"); err != nil {
		t.Fatal(err)
	}

	m.Sweep()

	stored, _ := m.Get(call.ID)
	if stored.State != StateActive {
		t.Fatalf("state = %q, want active", stored.State)
	}
}

func TestSweepRemovesOldEndedCalls(t *testing.T) {
	now := time.Now()
	m := testManager(func() time.Time { return now })

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := m.EndCall(call.ID, ReasonHangup); err != nil {
		t.Fatal(err)
	}

	now = now.Add(EndedTTL + time.Minute)
	m.Sweep()

	if _, ok := m.Get(call.ID); ok {
		t.Fatal("the ended call was not removed")
	}
}

func TestSweepEndsCallsThatWereNotAnswered(t *testing.T) {
	now := time.Now()
	m := testManager(func() time.Time { return now })

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(RingingTimeout + time.Minute)
	m.Sweep()

	stored, _ := m.Get(call.ID)
	if stored.State != StateEnded {
		t.Fatalf("state = %q, want ended", stored.State)
	}

	if stored.Reason != ReasonTimeout {
		t.Fatalf("reason = %q, want %q", stored.Reason, ReasonTimeout)
	}
}

// The window of the answer is closed: a call that was not answered in time
// cannot be accepted any more, even before the sweep reaches it.
func TestAcceptCallRejectsAnExpiredCall(t *testing.T) {
	now := time.Now()
	m := testManager(func() time.Time { return now })

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(RingingTimeout + time.Minute)

	if _, err := m.AcceptCall(call.ID, "answer"); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

// The registry reports the calls it ends on its own, so the participants
// learn the outcome.
func TestSweepReportsTheEndedCall(t *testing.T) {
	now := time.Now()
	m := testManager(func() time.Time { return now })

	var ended []Call
	m.SetOnEnded(func(call Call, _ string) {
		ended = append(ended, call)
	})

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(RingingTimeout + time.Minute)
	m.Sweep()

	if len(ended) != 1 {
		t.Fatalf("reported %d ended calls, want 1", len(ended))
	}

	if ended[0].ID != call.ID || ended[0].Reason != ReasonTimeout {
		t.Fatalf("reported %+v", ended[0])
	}
}

// The shutdown ends the calls and reports them: the clients have to receive
// the final state before the hub is closed.
func TestCloseReportsTheEndedCalls(t *testing.T) {
	m := testManager(time.Now)

	var ended []Call
	m.SetOnEnded(func(call Call, _ string) {
		ended = append(ended, call)
	})

	if _, err := m.CreateCall("alice", "bob", "chat-1", "offer"); err != nil {
		t.Fatal(err)
	}

	m.Close()

	if len(ended) != 1 || ended[0].Reason != ReasonPeerLeft {
		t.Fatalf("reported %+v", ended)
	}
}

// The registry writes the fields of a call under its lock, and the callers
// read them without it. The registry hands out copies, so the two do not race.
func TestConcurrentReadAndEnd(t *testing.T) {
	m := testManager(time.Now)

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup

	wg.Go(func() {
		for range 200 {
			_, _ = m.Current("alice")
			_, _ = m.Get(call.ID)
		}
	})

	wg.Go(func() {
		for range 200 {
			_, _ = m.EndCall(call.ID, ReasonHangup)
		}
	})

	wg.Wait()
}

// A call ends with exactly one event: whoever ends it first, the others find
// it already over and change nothing.
func TestEndCallReportsOnlyOnce(t *testing.T) {
	m := testManager(time.Now)

	var ended []Call
	m.SetOnEnded(func(call Call, _ string) {
		ended = append(ended, call)
	})

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	endedByMe, err := m.EndCall(call.ID, ReasonTimeout)
	if err != nil {
		t.Fatal(err)
	}

	if !endedByMe {
		t.Fatal("the first ending was not reported")
	}

	endedByOther, err := m.EndCall(call.ID, ReasonHangup)
	if err != nil {
		t.Fatal(err)
	}

	if endedByOther {
		t.Fatal("the second ending was reported as performed")
	}

	if len(ended) != 1 {
		t.Fatalf("reported %d endings, want 1", len(ended))
	}
}

// The window of the answer has its own timer: the call ends exactly when it
// runs out, and the users are free again right away.
func TestTheRingingWindowEndsTheCall(t *testing.T) {
	m := testManager(time.Now)
	m.ringingTimeout = 20 * time.Millisecond

	// The timer ends the call from another goroutine, so the report goes
	// through a channel.
	ended := make(chan Call, 1)
	m.SetOnEnded(func(call Call, _ string) {
		ended <- call
	})

	if _, err := m.CreateCall("alice", "bob", "chat-1", "offer"); err != nil {
		t.Fatal(err)
	}

	var reported Call

	select {
	case reported = <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("the call was not ended when the window ran out")
	}

	if reported.Reason != ReasonTimeout {
		t.Fatalf("reason = %q, want %q", reported.Reason, ReasonTimeout)
	}

	// The user is free again right away.
	if _, err := m.CreateCall("alice", "carol", "chat-2", "offer"); err != nil {
		t.Fatalf("the caller is still busy: %v", err)
	}
}

// The timer of the window must not end a call that was accepted in the
// meantime: the correctness cannot depend on the order of the two calls.
func TestTheRingingTimerKeepsAnAcceptedCall(t *testing.T) {
	m := testManager(time.Now)
	m.ringingTimeout = 20 * time.Millisecond

	ended := make(chan Call, 1)
	m.SetOnEnded(func(call Call, _ string) {
		ended <- call
	})

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	accepted, err := m.AcceptCall(call.ID, "answer")
	if err != nil {
		t.Fatal(err)
	}

	if accepted.State != StateActive {
		t.Fatalf("state = %q, want active", accepted.State)
	}

	select {
	case reported := <-ended:
		t.Fatalf("the accepted call was ended: %+v", reported)
	case <-time.After(100 * time.Millisecond):
	}

	stored, _ := m.Get(call.ID)
	if stored.State != StateActive {
		t.Fatalf("state = %q, want active", stored.State)
	}
}

func TestCloseEndsEveryCall(t *testing.T) {
	m := testManager(time.Now)

	call, err := m.CreateCall("alice", "bob", "chat-1", "offer")
	if err != nil {
		t.Fatal(err)
	}

	m.Close()

	stored, ok := m.Get(call.ID)
	if !ok {
		t.Fatal("the call is gone")
	}

	if stored.State != StateEnded {
		t.Fatalf("state = %q, want ended", stored.State)
	}
}
