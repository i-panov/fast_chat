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
