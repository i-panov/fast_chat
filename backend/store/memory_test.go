package store

import (
	"fmt"
	"testing"
	"time"

	"fast_chat/model"
)

func TestCreateUser(t *testing.T) {
	s := New()

	user, err := s.CreateUser("alice:localhost:8080", "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if user.ID != "alice:localhost:8080" {
		t.Errorf("expected ID alice:localhost:8080, got %s", user.ID)
	}
	if user.Nick != "alice" {
		t.Errorf("expected Nick alice, got %s", user.Nick)
	}
	if user.Token == "" {
		t.Error("expected non-empty token")
	}

	_, err = s.CreateUser("alice:localhost:8080", "alice")
	if err == nil {
		t.Error("expected error for duplicate nick")
	}
}

func TestGetUserByToken(t *testing.T) {
	s := New()

	user, _ := s.CreateUser("bob:test", "bob")
	found, ok := s.GetUserByToken(user.Token)
	if !ok {
		t.Fatal("expected to find user by token")
	}
	if found.ID != user.ID {
		t.Errorf("expected %s, got %s", user.ID, found.ID)
	}

	_, ok = s.GetUserByToken("invalid-token")
	if ok {
		t.Error("expected false for invalid token")
	}
}

func TestGetUserByID(t *testing.T) {
	s := New()

	user, _ := s.CreateUser("carol:test", "carol")
	found, ok := s.GetUserByID(user.ID)
	if !ok {
		t.Fatal("expected to find user by ID")
	}
	if found.Nick != "carol" {
		t.Errorf("expected carol, got %s", found.Nick)
	}
}

func TestSearchUsers(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("dalia:test", "dalia")

	results := s.SearchUsers("ali", "")
	if len(results) != 2 {
		t.Errorf("expected 2 results (alice, dalia), got %d", len(results))
	}

	results = s.SearchUsers("bob", "")
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}

	results = s.SearchUsers("xyz", "")
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}

	results = s.SearchUsers("ali", "alice:test")
	if len(results) != 1 {
		t.Errorf("expected 1 result (dalia excluding alice), got %d", len(results))
	}
}

func TestCreateChat(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")

	chat, err := s.CreateChat("alice:test", "bob:test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(chat.Members) != 2 {
		t.Errorf("expected 2 members, got %d", len(chat.Members))
	}

	same, err := s.CreateChat("alice:test", "bob:test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if same.ID != chat.ID {
		t.Error("expected same chat ID for existing conversation")
	}
}

func TestGetUserChats(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	s.CreateChat("alice:test", "bob:test")
	s.CreateChat("alice:test", "carol:test")

	chats := s.GetUserChats("alice:test")
	if len(chats) != 2 {
		t.Errorf("expected 2 chats, got %d", len(chats))
	}

	chats = s.GetUserChats("bob:test")
	if len(chats) != 1 {
		t.Errorf("expected 1 chat, got %d", len(chats))
	}
}

func TestAddMessage(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")

	msg, err := s.AddMessage(chat.ID, "alice:test", "alice", "Hello!", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if msg.Text != "Hello!" {
		t.Errorf("expected 'Hello!', got '%s'", msg.Text)
	}
	if msg.FromID != "alice:test" {
		t.Errorf("expected alice:test, got %s", msg.FromID)
	}
	if msg.ChatID != chat.ID {
		t.Errorf("expected %s, got %s", chat.ID, msg.ChatID)
	}

	_, err = s.AddMessage("nonexistent", "alice:test", "alice", "test", "")
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestEditMessage(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "")

	updated, err := s.EditMessage(chat.ID, msg.ID, "alice:test", "Edited!")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Text != "Edited!" {
		t.Errorf("expected 'Edited!', got '%s'", updated.Text)
	}
	if updated.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	_, err = s.EditMessage(chat.ID, msg.ID, "bob:test", "Hacked!")
	if err == nil {
		t.Error("expected error when bob edits alice's message")
	}
}

func TestDeleteMessage(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "")

	err := s.DeleteMessage(chat.ID, msg.ID, "alice:test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	err = s.DeleteMessage(chat.ID, "nonexistent", "alice:test")
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestGetMessagesPaginated(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")

	for i := 0; i < 10; i++ {
		s.AddMessage(chat.ID, "alice:test", "alice", fmt.Sprintf("msg-%d", i), "")
	}

	msgs, next, hasMore := s.GetMessagesPaginated(chat.ID, 4, "")
	if len(msgs) != 4 {
		t.Errorf("expected 4 messages, got %d", len(msgs))
	}
	if next == "" {
		t.Error("expected nextCursor for first page")
	}
	if !hasMore {
		t.Error("expected hasMore=true for first page")
	}

	msgs, next, hasMore = s.GetMessagesPaginated(chat.ID, 10, next)
	if len(msgs) != 6 {
		t.Errorf("expected 6 messages (remaining), got %d", len(msgs))
	}
	if hasMore {
		t.Error("expected hasMore=false after loading all")
	}

	msgs, _, _ = s.GetMessagesPaginated(chat.ID, 100, "")
	if len(msgs) != 10 {
		t.Errorf("expected all 10 messages, got %d", len(msgs))
	}
}

func TestCreateRemoteChat(t *testing.T) {
	s := New()

	s.CreateUser("alice:local", "alice")
	s.CreateUser("bob:remote", "bob")

	chat := &model.Chat{
		ID:           "remote-chat-id",
		Members:      []string{"alice:local", "bob:remote"},
		CreatedAt:    time.Now(),
		RemoteServer: "remote.com",
	}

	s.CreateRemoteChat(chat)

	got, ok := s.GetChat("remote-chat-id")
	if !ok {
		t.Fatal("expected to find remote chat")
	}
	if got.RemoteServer != "remote.com" {
		t.Errorf("expected RemoteServer=remote.com, got %s", got.RemoteServer)
	}
}
