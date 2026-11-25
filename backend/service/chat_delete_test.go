package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"fast_chat/model"
)

func TestDeleteChatForUserHidesOnlyForRequester(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.CreatePrivateChat(ctx, alice.ID, bob.ID, false)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteChatForUser(ctx, chat.ID, alice.ID); err != nil {
		t.Fatal(err)
	}

	if containsChat(s.store.GetUserChats(ctx, alice.ID), chat.ID) {
		t.Fatal("the chat is still visible to the member who deleted it")
	}
	if !containsChat(s.store.GetUserChats(ctx, bob.ID), chat.ID) {
		t.Fatal("deleting for one member removed the chat for the other one")
	}

	// Opening the chat again brings it back into the list.
	if _, err := s.CreatePrivateChat(ctx, alice.ID, bob.ID, false); err != nil {
		t.Fatal(err)
	}
	if !containsChat(s.store.GetUserChats(ctx, alice.ID), chat.ID) {
		t.Fatal("reopening the chat did not clear the deletion tombstone")
	}
}

func TestNewMessageUnhidesDeletedPrivateChat(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.store.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	view, err := s.CreatePrivateChat(ctx, alice.ID, bob.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteChatForUser(ctx, view.ID, alice.ID); err != nil {
		t.Fatal(err)
	}

	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("chat disappeared")
	}
	if _, err := s.SendMessage(ctx, chat, "", bob.ID, bob.Username, &SendMessageInput{Text: "hi"}); err != nil {
		t.Fatal(err)
	}

	if !containsChat(s.store.GetUserChats(ctx, alice.ID), view.ID) {
		t.Fatal("a new message did not bring the deleted chat back")
	}
}

func TestDeleteChatForUserRejectsGroup(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	owner, err := s.store.CreateUser(ctx, "owner@test.local", "owner", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	group, err := s.CreateGroupChat(ctx, owner.ID, "Team", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteChatForUser(ctx, group.ID, owner.ID); !errors.Is(err, ErrDeleteGroupChat) {
		t.Fatalf("DeleteChatForUser(group) = %v, want ErrDeleteGroupChat", err)
	}
}

func TestDeleteChatForUserRejectsFavorites(t *testing.T) {
	s := newTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	self, err := s.store.EnsureSelfChat(ctx, alice.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteChatForUser(ctx, self.ID, alice.ID); !errors.Is(err, ErrDeleteSelfChat) {
		t.Fatalf("DeleteChatForUser(self) = %v, want ErrDeleteSelfChat", err)
	}
}

func containsChat(chats []*model.Chat, id string) bool {
	for _, chat := range chats {
		if chat.ID == id {
			return true
		}
	}

	return false
}
