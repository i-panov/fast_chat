package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

// The outbox keeps the order of the operations of one peer: a failed
// operation blocks the queue of its peer until it is delivered, also across
// the ticks. Without that barrier the message of a chat would be sent before
// the chat itself, and the peer would answer 404.
func TestDueFederationOpsBlocksTheQueueOfAPeer(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	first := &model.FederationOp{
		RemoteServer: "peer.test",
		Method:       "POST",
		Path:         "/first",
	}
	if err := s.EnqueueFederationOp(ctx, first); err != nil {
		t.Fatal(err)
	}

	second := &model.FederationOp{
		RemoteServer: "peer.test",
		Method:       "POST",
		Path:         "/second",
	}
	if err := s.EnqueueFederationOp(ctx, second); err != nil {
		t.Fatal(err)
	}

	other := &model.FederationOp{
		RemoteServer: "other.test",
		Method:       "POST",
		Path:         "/other",
	}
	if err := s.EnqueueFederationOp(ctx, other); err != nil {
		t.Fatal(err)
	}

	// The first operation fails and is postponed.
	if err := s.RescheduleFederationOp(ctx, first.ID, 1, time.Now().UTC().Add(time.Minute), "boom"); err != nil {
		t.Fatal(err)
	}

	ops, err := s.DueFederationOps(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}

	if len(ops) != 1 || ops[0].ID != other.ID {
		t.Fatalf("due operations = %+v, want only the operation of the other peer", ops)
	}

	// Once the failed operation is due again, the queue of the peer moves on
	// as a whole.
	if err := s.RescheduleFederationOp(ctx, first.ID, 1, time.Now().UTC().Add(-time.Second), "boom"); err != nil {
		t.Fatal(err)
	}

	ops, err = s.DueFederationOps(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}

	if len(ops) < 2 {
		t.Fatalf("due operations = %+v, want the operations of the peer", ops)
	}

	if ops[0].Path != "/first" || ops[1].Path != "/second" {
		t.Fatalf("the operations of the peer are out of order: %+v", ops)
	}
}

func TestFederationCursor(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// A peer that was never polled starts at the epoch.
	if got := s.GetFederationCursor(ctx, "peer.test"); got.Unix() != 0 {
		t.Errorf("cursor of an unknown peer = %v, want the epoch", got)
	}

	now := time.Now().UTC().Truncate(time.Second)
	if err := s.SetFederationCursor(ctx, "peer.test", now); err != nil {
		t.Fatal(err)
	}

	got := s.GetFederationCursor(ctx, "peer.test")
	if !got.Equal(now) {
		t.Errorf("cursor = %v, want %v", got, now)
	}

	// The cursor moves forward.
	later := now.Add(time.Minute)
	if err := s.SetFederationCursor(ctx, "peer.test", later); err != nil {
		t.Fatal(err)
	}

	if got := s.GetFederationCursor(ctx, "peer.test"); !got.Equal(later) {
		t.Errorf("cursor = %v, want %v", got, later)
	}
}
