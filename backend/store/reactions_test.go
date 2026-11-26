package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

func TestMessageReactionAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	msg := model.Message{
		ID:        "m1",
		ChatID:    "c1",
		FromID:    "alice:test",
		FromNick:  "alice",
		Text:      "hi",
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := s.DB().Create(&msg).Error; err != nil {
		t.Fatal(err)
	}

	if err := s.AddMessageReaction(ctx, "m1", "alice:test", "👍"); err != nil {
		t.Fatal(err)
	}
	// Idempotent: the same user and emoji is one row.
	if err := s.AddMessageReaction(ctx, "m1", "alice:test", "👍"); err != nil {
		t.Fatal(err)
	}
	if err := s.AddMessageReaction(ctx, "m1", "bob:test", "👍"); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetReactionsForMessages(ctx, []string{"m1"}, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if len(got["m1"]) != 1 || got["m1"][0].Count != 2 || !got["m1"][0].Me {
		t.Fatalf("reactions = %+v", got["m1"])
	}

	if err := s.RemoveMessageReaction(ctx, "m1", "alice:test", "👍"); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetReactionsForMessages(ctx, []string{"m1"}, "alice:test")
	if err != nil {
		t.Fatal(err)
	}
	if got["m1"][0].Count != 1 || got["m1"][0].Me {
		t.Fatalf("after remove = %+v", got["m1"])
	}
}

func TestReactionTombstonesAndStaleEvents(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	msg := model.Message{
		ID: "m1", ChatID: "c1", FromID: "alice:test", FromNick: "alice", Text: "hi",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := s.DB().Create(&msg).Error; err != nil {
		t.Fatal(err)
	}

	added := time.Now().UTC().Add(-time.Minute)
	if err := s.AddMessageReactionAt(ctx, "m1", "bob:test", "👍", added); err != nil {
		t.Fatal(err)
	}

	removed := added.Add(10 * time.Second)
	if err := s.RemoveMessageReactionAt(ctx, "m1", "bob:test", "👍", removed); err != nil {
		t.Fatal(err)
	}

	// A delayed retry of the older add must not resurrect the reaction.
	if err := s.AddMessageReactionAt(ctx, "m1", "bob:test", "👍", added); err != nil {
		t.Fatal(err)
	}
	rows, err := s.GetMessageReactionRows(ctx, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("reaction resurrected by a stale add: %+v", rows)
	}

	deletions, err := s.ReactionDeletionsSince(ctx, []string{"c1"}, added, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deletions.Rows) != 1 || !deletions.Rows[0].RemovedAt.Equal(removed) {
		t.Fatalf("deletions = %+v", deletions.Rows)
	}

	// Re-adding after the removal clears the tombstone and is visible in the
	// live-reaction feed.
	readded := removed.Add(10 * time.Second)
	if err := s.AddMessageReactionAt(ctx, "m1", "bob:test", "👍", readded); err != nil {
		t.Fatal(err)
	}
	reactions, err := s.ReactionsChangedSince(ctx, []string{"c1"}, added, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(reactions.Rows) != 1 {
		t.Fatalf("reactions = %+v", reactions.Rows)
	}
	deletions, err = s.ReactionDeletionsSince(ctx, []string{"c1"}, added, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deletions.Rows) != 0 {
		t.Fatalf("tombstone survived re-add: %+v", deletions.Rows)
	}
}
