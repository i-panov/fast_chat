package service

import (
	"testing"
	"time"

	"fast_chat/model"
)

// A tombstone and the visible chat of the same id must never travel together:
// the client applies tombstones first and would drop the chat with its local
// history. The two lists are read at different instants, so a chat unhidden in
// between produces exactly that pair.
func TestDropVisibleChatTombstonesKeepsUnhiddenChats(t *testing.T) {
	now := time.Now().UTC()
	tombs := []SyncDeletedChatDTO{
		{ChatID: "hidden", DeletedAt: now},
		{ChatID: "unhidden", DeletedAt: now},
	}
	chats := []*model.Chat{{ID: "unhidden"}, {ID: "other"}}

	got := dropVisibleChatTombstones(tombs, chats)
	if len(got) != 1 || got[0].ChatID != "hidden" {
		t.Fatalf("tombstones = %+v, want only the hidden chat", got)
	}

	// Without a chat list nothing is filtered: a deleted chat that is gone
	// stays reported.
	if got := dropVisibleChatTombstones(tombs, nil); len(got) != len(tombs) {
		t.Fatalf("tombstones = %+v, want both", got)
	}

	if got := dropVisibleChatTombstones(nil, chats); got != nil {
		t.Fatalf("no tombstones must stay nil, got %+v", got)
	}
}
