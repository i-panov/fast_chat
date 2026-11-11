package store

import (
	"context"
	"testing"
)

func TestUserBlocks(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.BlockUser(ctx, "alice:test", "bob:test"); err != nil {
		t.Fatal(err)
	}
	// Idempotent.
	if err := s.BlockUser(ctx, "alice:test", "bob:test"); err != nil {
		t.Fatal(err)
	}

	if !s.IsBlockedBetween(ctx, "alice:test", "bob:test") ||
		!s.IsBlockedBetween(ctx, "bob:test", "alice:test") {

		t.Fatal("block must apply in both directions")
	}
	ids, err := s.BlockedIDs(ctx, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "bob:test" {
		t.Fatalf("blocked = %v", ids)
	}
	by, err := s.BlockedByIDs(ctx, "bob:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(by) != 1 || by[0] != "alice:test" {
		t.Fatalf("blocked by = %v", by)
	}

	if err := s.UnblockUser(ctx, "alice:test", "bob:test"); err != nil {
		t.Fatal(err)
	}
	if s.IsBlockedBetween(ctx, "alice:test", "bob:test") {
		t.Fatal("unblock did not remove the relation")
	}
}
