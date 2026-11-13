package store

import (
	"context"
	"testing"

	"fast_chat/model"
)

func TestChatPins(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	user := createTestUser(t, s, "alice")
	chat, err := s.EnsureSelfChat(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	msg, _, err := s.AddMessage(ctx, chat.ID, "", user.ID, user.Username, "pin me", "m1", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.PinMessage(ctx, chat.ID, msg.ID, user.ID); err != nil {
		t.Fatal(err)
	}
	// Idempotent.
	if err := s.PinMessage(ctx, chat.ID, msg.ID, user.ID); err != nil {
		t.Fatal(err)
	}

	ids, err := s.GetPinnedMessageIDs(ctx, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != msg.ID {
		t.Fatalf("pins = %v", ids)
	}
	messages, err := s.GetPinnedMessages(ctx, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Text != "pin me" {
		t.Fatalf("messages = %+v", messages)
	}

	if err := s.UnpinMessage(ctx, chat.ID, msg.ID); err != nil {
		t.Fatal(err)
	}
	ids, err = s.GetPinnedMessageIDs(ctx, chat.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatalf("pins after unpin = %v", ids)
	}

	// A deleted message takes its pin with it.
	_ = s.PinMessage(ctx, chat.ID, msg.ID, user.ID)
	if err := s.DeleteMessage(ctx, chat.ID, msg.ID, user.ID); err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := s.DB().Model(&model.ChatPin{}).Where("chat_id = ?", chat.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("orphan pins = %d", count)
	}
}
