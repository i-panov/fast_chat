package store

import (
	"context"
	"testing"
	"time"

	"fast_chat/model"
)

func TestReaddedGroupMemberSeesChatAgain(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	owner := createTestUser(t, s, "owner")
	member := createTestUser(t, s, "member")

	chat, err := s.CreateGroupChat(ctx, "Team", owner.ID, []string{member.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.RemoveChatMember(ctx, chat.ID, member.ID); err != nil {
		t.Fatal(err)
	}
	if userHasChat(s.GetUserChats(ctx, member.ID), chat.ID) {
		t.Fatal("removed member still sees the chat")
	}

	if err := s.AddChatMember(ctx, chat.ID, member.ID, 0); err != nil {
		t.Fatal(err)
	}
	if !userHasChat(s.GetUserChats(ctx, member.ID), chat.ID) {
		t.Fatal("re-added member does not see the chat: tombstone was not cleared")
	}
}

func TestEnsureSelfChatClearsStaleTombstone(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	user := createTestUser(t, s, "alice")

	self, err := s.EnsureSelfChat(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}

	// An admin delete leaves a tombstone behind; EnsureSelfChat recreates the
	// chat under the same deterministic id.
	if err := s.db.Create(&model.DeletedChat{
		ChatID:    self.ID,
		UserID:    user.ID,
		DeletedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if userHasChat(s.GetUserChats(ctx, user.ID), self.ID) {
		t.Fatal("hidden favorites chat is still visible")
	}

	if _, err := s.EnsureSelfChat(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	if !userHasChat(s.GetUserChats(ctx, user.ID), self.ID) {
		t.Fatal("recreated favorites chat is hidden by the stale tombstone")
	}
}

func userHasChat(chats []*model.Chat, id string) bool {
	for _, chat := range chats {
		if chat.ID == id {
			return true
		}
	}

	return false
}
