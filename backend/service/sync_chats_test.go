package service

import (
	"context"
	"testing"
	"time"
)

// The sync carries the whole list of the user's chats. A chat the user joined
// while offline, a renamed group and a changed membership are all invisible
// to a "changed since" query, because the chat itself was created long ago.
func TestSyncReturnsTheWholeChatList(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateGroupChat(ctx, "Old name", alice.ID, []string{bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	// The group was renamed and bob joined after the last sync.
	if _, err := s.store.UpdateChatName(ctx, chat.ID, "New name"); err != nil {
		t.Fatal(err)
	}

	if err := s.store.AddChatMember(ctx, chat.ID, "carol:localhost:8080", 100); err != nil {
		t.Fatal(err)
	}

	resp, err := s.Sync(ctx, alice.ID, time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var found *SyncChatDTO

	for i := range resp.Chats {
		if resp.Chats[i].ID == chat.ID {
			found = &resp.Chats[i]
		}
	}

	if found == nil {
		t.Fatalf("the group is missing from the sync: %+v", resp.Chats)
	}

	if found.Name != "New name" {
		t.Errorf("chat name = %q, want %q", found.Name, "New name")
	}

	if len(found.Members) != 3 {
		t.Errorf("members = %v, want three", found.Members)
	}
}

// A member that was removed while offline learns about it through the
// tombstones of the delta.
func TestSyncReportsRemovedChats(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateGroupChat(ctx, "G", alice.ID, []string{bob.ID}, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.store.RemoveChatMember(ctx, chat.ID, bob.ID); err != nil {
		t.Fatal(err)
	}

	resp, err := s.Sync(ctx, bob.ID, time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(resp.DeletedChats) != 1 || resp.DeletedChats[0].ChatID != chat.ID {
		t.Fatalf("expected the removed chat to be reported, got %+v", resp.DeletedChats)
	}

	for _, c := range resp.Chats {
		if c.ID == chat.ID {
			t.Fatalf("the removed chat is still in the chat list: %+v", resp.Chats)
		}
	}
}

// The messages of the threads travel in their own list: they live in their
// own store on the client, and a single list would put every thread message
// back into the chat feed.
func TestSyncReturnsTheThreadMessages(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice.ID, bob.ID, "")
	if err != nil {
		t.Fatal(err)
	}

	parent, _, err := s.store.AddMessage(ctx, chat.ID, "", alice.ID, "alice", "parent", "", "", nil, false, "")
	if err != nil {
		t.Fatal(err)
	}

	thread, err := s.store.CreateThread(ctx, chat.ID, parent.ID, parent.Text, parent.FromNick)
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := s.store.AddMessage(ctx, chat.ID, thread.ID, bob.ID, "bob", "in the thread", "", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	resp, err := s.Sync(ctx, alice.ID, time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(resp.Messages) != 1 || resp.Messages[0].Text != "parent" {
		t.Fatalf("expected the chat message in the chat list, got %+v", resp.Messages)
	}

	if len(resp.ThreadMessages) != 1 {
		t.Fatalf("expected one thread message, got %+v", resp.ThreadMessages)
	}

	if resp.ThreadMessages[0].Text != "in the thread" {
		t.Errorf("thread message = %q, want %q", resp.ThreadMessages[0].Text, "in the thread")
	}

	if resp.ThreadMessages[0].ThreadID != thread.ID {
		t.Errorf("thread id = %q, want %q", resp.ThreadMessages[0].ThreadID, thread.ID)
	}
}
