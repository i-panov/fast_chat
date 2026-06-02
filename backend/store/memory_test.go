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

	msg, err := s.AddMessage(chat.ID, "alice:test", "alice", "Hello!", "", "")
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

	_, err = s.AddMessage("nonexistent", "alice:test", "alice", "test", "", "")
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestEditMessage(t *testing.T) {
	s := New()

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "", "")

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
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "", "")

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
		s.AddMessage(chat.ID, "alice:test", "alice", fmt.Sprintf("msg-%d", i), "", "")
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

func TestAddRawMessage(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")

	msg := &model.Message{
		ID:     "raw-1",
		ChatID: chat.ID,
		FromID: "bob:test",
		Text:   "from remote",
	}

	err := s.AddRawMessage(msg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msgs := s.GetMessages(chat.ID)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].ID != "raw-1" {
		t.Errorf("expected raw-1, got %s", msgs[0].ID)
	}

	err = s.AddRawMessage(&model.Message{ChatID: "nonexistent"})
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestEditRawMessage(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "msg-1", "")

	now := time.Now()
	err := s.EditRawMessage(chat.ID, "msg-1", "Edited!", now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msg, err := s.GetMessage(chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}
	if msg.Text != "Edited!" {
		t.Errorf("expected 'Edited!', got '%s'", msg.Text)
	}
	if msg.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	err = s.EditRawMessage(chat.ID, "nonexistent", "", time.Now())
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestDeleteRawMessage(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "msg-1", "")

	err := s.DeleteRawMessage(chat.ID, "msg-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msgs := s.GetMessages(chat.ID)
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}

	err = s.DeleteRawMessage(chat.ID, "nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestCreateThreadAndGet(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Parent", "parent-1", "")

	thread, err := s.CreateThread(chat.ID, "parent-1", "Parent", "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if thread.ParentMessageID != "parent-1" {
		t.Errorf("expected parent-1, got %s", thread.ParentMessageID)
	}

	got, ok := s.GetThread(thread.ID)
	if !ok {
		t.Fatal("expected to find thread")
	}
	if got.ID != thread.ID {
		t.Errorf("expected %s, got %s", thread.ID, got.ID)
	}

	byParent, ok := s.GetThreadByParentMessage(chat.ID, "parent-1")
	if !ok {
		t.Fatal("expected to find thread by parent message")
	}
	if byParent.ID != thread.ID {
		t.Errorf("expected %s, got %s", thread.ID, byParent.ID)
	}

	_, err = s.CreateThread(chat.ID, "parent-1", "Parent", "alice")
	if err == nil {
		t.Error("expected error for duplicate thread")
	}

	_, err = s.CreateThread("nonexistent", "msg", "", "")
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestGetThreadsForChat(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Msg1", "m1", "")
	s.AddMessage(chat.ID, "alice:test", "alice", "Msg2", "m2", "")

	s.CreateThread(chat.ID, "m1", "Msg1", "alice")
	s.CreateThread(chat.ID, "m2", "Msg2", "alice")

	threads := s.GetThreadsForChat(chat.ID)
	if len(threads) != 2 {
		t.Errorf("expected 2 threads, got %d", len(threads))
	}

	noThreads := s.GetThreadsForChat("nonexistent")
	if len(noThreads) != 0 {
		t.Errorf("expected 0 threads, got %d", len(noThreads))
	}
}

func TestAddThreadMessage(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Parent", "parent-1", "")
	thread, _ := s.CreateThread(chat.ID, "parent-1", "Parent", "alice")

	msg, err := s.AddThreadMessage(thread.ID, "bob:test", "bob", "Reply", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg.Text != "Reply" {
		t.Errorf("expected 'Reply', got '%s'", msg.Text)
	}

	got, ok := s.GetThread(thread.ID)
	if !ok {
		t.Fatal("expected to find thread")
	}
	if got.MessageCount != 1 {
		t.Errorf("expected MessageCount=1, got %d", got.MessageCount)
	}

	msgs, _, _ := s.GetThreadMessagesPaginated(thread.ID, 10, "")
	if len(msgs) != 1 {
		t.Errorf("expected 1 thread message, got %d", len(msgs))
	}

	_, err = s.AddThreadMessage("nonexistent", "alice:test", "alice", "test", "", "")
	if err == nil {
		t.Error("expected error for nonexistent thread")
	}
}

func TestAddConnection(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	user, _ := s.GetUserByID("alice:test")

	if !user.Online {
		t.Error("expected user to be online after creation")
	}

	s.AddConnection("alice:test")

	s.RemoveConnection("alice:test")
	if user.Online {
		t.Error("expected user to be offline after RemoveConnection")
	}
}

func TestAddConnectionMultiple(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	user, _ := s.GetUserByID("alice:test")

	s.AddConnection("alice:test")
	s.AddConnection("alice:test")
	s.RemoveConnection("alice:test")

	if !user.Online {
		t.Error("expected user to stay online after one RemoveConnection (still one left)")
	}

	s.RemoveConnection("alice:test")
	if user.Online {
		t.Error("expected user to be offline after all connections removed")
	}
}

func TestGetMessageValue(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "msg-1", "")

	msg1, err := s.GetMessage(chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	msg2, err := s.GetMessage(chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	msg1.Text = "modified"
	if msg2.Text == "modified" {
		t.Error("GetMessage should return a copy, modifications to one should not affect the other")
	}
}

func TestGetThreadValue(t *testing.T) {
	s := New()
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	s.AddMessage(chat.ID, "alice:test", "alice", "Parent", "parent-1", "")
	s.CreateThread(chat.ID, "parent-1", "Parent", "alice")

	threads := s.GetThreadsForChat(chat.ID)
	thread1, _ := s.GetThread(threads[0].ID)
	thread2, _ := s.GetThread(threads[0].ID)

	thread1.ChatID = "modified"
	if thread2.ChatID == "modified" {
		t.Error("GetThread should return a copy")
	}
}
