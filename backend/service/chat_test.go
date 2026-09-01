package service

import (
	"testing"

	"fast_chat/model"
)

func TestIsMember(t *testing.T) {
	chat := &model.Chat{
		ID:      "chat1",
		Members: []string{"alice", "bob"},
	}

	if !IsMember(chat, "alice") {
		t.Error("expected alice to be a member")
	}
	if !IsMember(chat, "bob") {
		t.Error("expected bob to be a member")
	}
	if IsMember(chat, "carol") {
		t.Error("expected carol to not be a member")
	}
}

func TestIsOwner(t *testing.T) {
	chat := &model.Chat{
		ID:      "chat1",
		OwnerID: "alice",
	}

	if !IsOwner(chat, "alice") {
		t.Error("expected alice to be the owner")
	}
	if IsOwner(chat, "bob") {
		t.Error("expected bob to not be the owner")
	}

	noOwner := &model.Chat{ID: "chat2"}
	if IsOwner(noOwner, "alice") {
		t.Error("expected no one to own a chat without an owner")
	}
}

func TestCollectChatAndMemberIDs(t *testing.T) {
	chats := []*model.Chat{
		{ID: "c1", Members: []string{"alice", "bob"}},
		{ID: "c2", Members: []string{"bob", "carol"}},
		{ID: "c1", Members: []string{"alice"}},
	}

	chatIDs, memberIDs := collectChatAndMemberIDs(chats)

	if len(chatIDs) != 2 || chatIDs[0] != "c1" || chatIDs[1] != "c2" {
		t.Fatalf("chatIDs = %v, want [c1 c2]", chatIDs)
	}

	if len(memberIDs) != 3 {
		t.Fatalf("memberIDs = %v, want 3 deduplicated members", memberIDs)
	}
}

func TestGroupMemberNotFoundError(t *testing.T) {
	err := &GroupMemberNotFoundError{ID: "missing"}
	if got := err.Error(); got != "user not found: missing" {
		t.Errorf("GroupMemberNotFoundError.Error() = %q, want %q", got, "user not found: missing")
	}
}
