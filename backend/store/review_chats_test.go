package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"fast_chat/model"
)

// Deleting a thread's parent must take the thread with it: leaving the row
// behind kept the deleted text in ParentMessageText and listed a conversation
// whose root no longer exists.
func TestDeleteParentMessageRemovesItsThread(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "parent", "parent-1", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.AddMessage(ctx, chat.ID, parent.ID, testBob, "bob", "reply", "reply-1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteMessage(ctx, chat.ID, parent.ID, testAlice); err != nil {
		t.Fatal(err)
	}

	if _, ok := s.GetThread(ctx, parent.ID); ok {
		t.Fatal("the thread of a deleted parent must be gone")
	}
	if _, err := s.GetMessage(ctx, chat.ID, "reply-1"); err == nil {
		t.Fatal("thread messages must not outlive their thread")
	}

	// Both removals are tombstoned, so an offline client drops them.
	var tombs []model.DeletedMessage
	if err := s.db.Where("chat_id = ?", chat.ID).Find(&tombs).Error; err != nil {
		t.Fatal(err)
	}
	if len(tombs) != 2 {
		t.Fatalf("tombstones = %d, want 2", len(tombs))
	}
}

// An edited parent refreshes the snapshot the thread list shows.
func TestEditParentMessageUpdatesThreadPreview(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateChat(ctx, testAlice, testBob, "")
	if err != nil {
		t.Fatal(err)
	}
	parent, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "old text", "parent-2", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick); err != nil {
		t.Fatal(err)
	}

	encrypted := false
	if _, err := s.EditMessage(ctx, chat.ID, "", parent.ID, testAlice, "new text", nil, false, &encrypted, nil); err != nil {
		t.Fatal(err)
	}

	thread, ok := s.GetThread(ctx, parent.ID)
	if !ok {
		t.Fatal("thread missing")
	}
	if thread.ParentMessageText != "new text" {
		t.Fatalf("thread preview = %q, want %q", thread.ParentMessageText, "new text")
	}
}

// Deleting a chat removes its pins: an orphan pin made a recreated favorites
// chat (deterministic id) advertise messages that no longer exist.
func TestDeleteChatCascadeClearsPins(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateGroupChat(ctx, "pins", testAlice, []string{testBob}, "")
	if err != nil {
		t.Fatal(err)
	}
	msg, _, err := s.AddMessage(ctx, chat.ID, "", testAlice, "alice", "pin me", "pin-msg", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PinMessage(ctx, chat.ID, msg.ID, testAlice); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteChat(ctx, chat.ID); err != nil {
		t.Fatal(err)
	}

	var pins int64
	if err := s.db.Model(&model.ChatPin{}).Where("chat_id = ?", chat.ID).Count(&pins).Error; err != nil {
		t.Fatal(err)
	}
	if pins != 0 {
		t.Fatalf("chat_pins rows left after the chat delete: %d", pins)
	}
}

// Two simultaneous "open the dialog" calls must not mint two private chats.
func TestCreatePrivateChatConcurrentCallsShareOneChat(t *testing.T) {
	// A file-backed store: the in-memory database is private to its
	// connection and would not reproduce the two-writer contention.
	s := initTestDB(t)
	ctx := context.Background()

	for _, nick := range []string{"alice", "bob"} {
		if _, err := s.CreateUser(ctx, nick+"@test.local", nick, "test", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	const workers = 4

	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		err error
	)

	ids := make([]string, 0, workers)

	for range workers {
		wg.Go(func() {
			chat, createErr := s.CreateChat(ctx, testAlice, testBob, "")
			if createErr != nil {
				mu.Lock()
				err = createErr
				mu.Unlock()

				return
			}
			mu.Lock()
			ids = append(ids, chat.ID)
			mu.Unlock()
		})
	}
	wg.Wait()

	if err != nil {
		t.Fatalf("CreateChat: %v", err)
	}
	if len(ids) != workers {
		t.Fatalf("chats = %d, want %d", len(ids), workers)
	}
	for _, id := range ids {
		if id != ids[0] {
			t.Fatalf("concurrent opens created several chats: %v", ids)
		}
	}
}

// Removing a user who is not a member must be reported, not silently
// acknowledged with member-removed events and a federation DELETE.
func TestRemoveChatMemberRejectsNonMember(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	chat, err := s.CreateGroupChat(ctx, "group", testAlice, []string{testBob}, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.RemoveChatMember(ctx, chat.ID, "dave:test"); !errors.Is(err, ErrNotMember) {
		t.Fatalf("err = %v, want ErrNotMember", err)
	}
}

// A blocked federated user has no local profile row, yet the block must stay
// visible in the settings list, or it can never be removed.
func TestPublicUserByIDFallsBackToTheID(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	fallback := s.PublicUserByID(ctx, "nick:remote.test")
	if fallback.ID != "nick:remote.test" {
		t.Fatalf("id = %q", fallback.ID)
	}
	if fallback.Nick != "nick" || fallback.Username != "nick" {
		t.Fatalf("fallback nick = %q/%q, want nick", fallback.Nick, fallback.Username)
	}

	user, err := s.CreateUser(ctx, "real@test.local", "real", "test", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.PublicUserByID(ctx, user.ID); got.Username != "real" {
		t.Fatalf("local user nick = %q, want real", got.Username)
	}
}
