package store

import (
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"fast_chat/model"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}); err != nil {
		t.Fatal(err)
	}

	return New(db)
}

func TestCreateUser(t *testing.T) {
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)

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

func TestSetMessageFiles(t *testing.T) {
	s := newTestStore(t)

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "Hello", "", "")

	f1, _ := s.SaveFile("hash1", "image/png", 100, "a.png", "a.png")
	f2, _ := s.SaveFile("hash2", "application/pdf", 200, "b.pdf", "b.pdf")
	f3, _ := s.SaveFile("hash3", "text/plain", 50, "c.txt", "c.txt")

	if err := s.AddMessageFiles(msg.ID, []string{f1.ID, f2.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := s.SetMessageFiles(msg.ID, []string{f2.ID, f3.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	files, err := s.GetMessageFiles(msg.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(files) != 2 {
		t.Fatalf("expected 2 files, got %d", len(files))
	}

	ids := map[string]bool{files[0].ID: true, files[1].ID: true}
	if !ids[f2.ID] || !ids[f3.ID] {
		t.Errorf("expected f2 and f3, got %v", ids)
	}
	if ids[f1.ID] {
		t.Error("f1 should have been removed")
	}
}

func TestEditThreadMessage(t *testing.T) {
	s := newTestStore(t)

	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")
	parent, _ := s.AddMessage(chat.ID, "alice:test", "alice", "parent", "", "")
	thread, _ := s.CreateThread(chat.ID, parent.ID, parent.Text, parent.FromNick)
	msg, _ := s.AddThreadMessage(thread.ID, "alice:test", "alice", "Hello", "", "")

	updated, err := s.EditThreadMessage(thread.ID, msg.ID, "alice:test", "Edited!")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Text != "Edited!" {
		t.Errorf("expected 'Edited!', got '%s'", updated.Text)
	}
	if updated.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	_, err = s.EditThreadMessage(thread.ID, msg.ID, "bob:test", "Hacked!")
	if err == nil {
		t.Error("expected error when bob edits alice's thread message")
	}

	_, err = s.EditThreadMessage("nonexistent", msg.ID, "alice:test", "x")
	if err == nil {
		t.Error("expected error for nonexistent thread")
	}
}

func TestGetMessagesPaginated(t *testing.T) {
	s := newTestStore(t)

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
	s := newTestStore(t)

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
	s := newTestStore(t)
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
	s := newTestStore(t)
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
	s := newTestStore(t)
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
	s := newTestStore(t)
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
	s := newTestStore(t)

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

func TestCreateChatIsPrivate(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")

	chat, err := s.CreateChat("alice:test", "bob:test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "private" {
		t.Errorf("expected type=private, got %q", chat.Type)
	}
}

func TestCreateGroupChatBasic(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	chat, err := s.CreateGroupChat("Team", "alice:test", []string{"bob:test", "carol:test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "group" {
		t.Errorf("expected type=group, got %q", chat.Type)
	}
	if chat.Name != "Team" {
		t.Errorf("expected name=Team, got %q", chat.Name)
	}
	if chat.OwnerID != "alice:test" {
		t.Errorf("expected ownerId=alice:test, got %q", chat.OwnerID)
	}
	if len(chat.Members) != 3 {
		t.Errorf("expected 3 members, got %d", len(chat.Members))
	}
}

func TestCreateGroupChatUnlimitedDuplicates(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	c1, _ := s.CreateGroupChat("G1", "alice:test", []string{"bob:test", "carol:test"})
	c2, _ := s.CreateGroupChat("G2", "alice:test", []string{"bob:test", "carol:test"})
	c3, _ := s.CreateGroupChat("G3", "alice:test", []string{"bob:test", "carol:test"})

	if c1.ID == c2.ID || c2.ID == c3.ID || c1.ID == c3.ID {
		t.Errorf("expected 3 distinct IDs, got %s %s %s", c1.ID, c2.ID, c3.ID)
	}

	chats := s.GetUserChats("alice:test")
	if len(chats) != 3 {
		t.Errorf("expected 3 chats for alice, got %d", len(chats))
	}
}

func TestCreateGroupChatDeduplicates(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	chat, err := s.CreateGroupChat("G", "alice:test", []string{"alice:test", "bob:test", "carol:test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(chat.Members) != 3 {
		t.Errorf("expected 3 unique members (dedup alice), got %d", len(chat.Members))
	}
}

func TestCreateGroupChatValidation(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")

	// owner + bob = 2 members, valid
	chat, err := s.CreateGroupChat("G", "alice:test", []string{"alice:test", "bob:test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chat.Members) != 2 {
		t.Errorf("expected 2 unique members, got %d", len(chat.Members))
	}
}

func TestCreateGroupChatSolo(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")

	chat, err := s.CreateGroupChat("Solo", "alice:test", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "group" {
		t.Errorf("expected type=group, got %q", chat.Type)
	}
	if chat.OwnerID != "alice:test" {
		t.Errorf("expected ownerId=alice:test, got %q", chat.OwnerID)
	}
	if len(chat.Members) != 1 {
		t.Errorf("expected 1 member (owner only), got %d", len(chat.Members))
	}
}

func TestAddChatMember(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")
	s.CreateUser("dave:test", "dave")

	chat, _ := s.CreateGroupChat("G", "alice:test", []string{"bob:test", "carol:test"})

	if err := s.AddChatMember(chat.ID, "dave:test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, _ := s.GetChat(chat.ID)
	if len(got.Members) != 4 {
		t.Errorf("expected 4 members, got %d", len(got.Members))
	}

	if err := s.AddChatMember(chat.ID, "dave:test"); err != nil {
		t.Errorf("idempotent add should not error: %v", err)
	}

	got, _ = s.GetChat(chat.ID)
	if len(got.Members) != 4 {
		t.Errorf("expected still 4 members after duplicate add, got %d", len(got.Members))
	}

	privateChat, _ := s.CreateChat("alice:test", "bob:test")
	if err := s.AddChatMember(privateChat.ID, "carol:test"); err == nil {
		t.Error("expected error adding member to private chat")
	}
}

func TestRemoveChatMember(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	chat, _ := s.CreateGroupChat("G", "alice:test", []string{"bob:test", "carol:test"})

	if err := s.RemoveChatMember(chat.ID, "bob:test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, _ := s.GetChat(chat.ID)
	if len(got.Members) != 2 {
		t.Errorf("expected 2 members, got %d", len(got.Members))
	}

	if err := s.RemoveChatMember(chat.ID, "carol:test"); err != nil {
		t.Fatalf("unexpected error removing carol: %v", err)
	}

	got, _ = s.GetChat(chat.ID)
	if len(got.Members) != 1 {
		t.Errorf("expected 1 member remaining, got %d", len(got.Members))
	}

	if err := s.RemoveChatMember(chat.ID, "alice:test"); err == nil {
		t.Error("expected error: cannot remove the last member")
	}

	if err := s.RemoveChatMember(chat.ID, "nobody:test"); err == nil {
		t.Error("expected error: removing nonexistent user should not error silently")
	}
}

func TestUpdateChatName(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	chat, _ := s.CreateGroupChat("Old", "alice:test", []string{"bob:test", "carol:test"})

	updated, err := s.UpdateChatName(chat.ID, "New")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Name != "New" {
		t.Errorf("expected New, got %q", updated.Name)
	}

	privateChat, _ := s.CreateChat("alice:test", "bob:test")
	if _, err := s.UpdateChatName(privateChat.ID, "X"); err == nil {
		t.Error("expected error renaming private chat")
	}
}

func TestUpdateChatAvatar(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")
	f, _ := s.SaveFile("hash", "image/png", 100, "a.png", "a.png")

	chat, _ := s.CreateGroupChat("G", "alice:test", []string{"bob:test", "carol:test"})

	updated, err := s.UpdateChatAvatar(chat.ID, f.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.AvatarFileID != f.ID {
		t.Errorf("expected avatar %s, got %q", f.ID, updated.AvatarFileID)
	}
}

func TestDeleteChatCascade(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")

	chat, _ := s.CreateGroupChat("G", "alice:test", []string{"bob:test", "carol:test"})
	msg, _ := s.AddMessage(chat.ID, "alice:test", "alice", "hi", "", "")
	thread, _ := s.CreateThread(chat.ID, msg.ID, "hi", "alice")
	s.AddThreadMessage(thread.ID, "bob:test", "bob", "reply", "", "")
	f, _ := s.SaveFile("h", "image/png", 1, "a.png", "a.png")
	s.AddMessageFiles(msg.ID, []string{f.ID})

	if err := s.DeleteChat(chat.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := s.GetChat(chat.ID); ok {
		t.Error("expected chat to be deleted")
	}

	if msgs := s.GetMessages(chat.ID); len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}

	if threads := s.GetThreadsForChat(chat.ID); len(threads) != 0 {
		t.Errorf("expected 0 threads, got %d", len(threads))
	}

	var memberCount int64
	s.db.Model(&ChatMember{}).Where("chat_id = ?", chat.ID).Count(&memberCount)
	if memberCount != 0 {
		t.Errorf("expected 0 chat members, got %d", memberCount)
	}

	var fileLinkCount int64
	s.db.Model(&model.MessageFile{}).Where("message_id = ?", msg.ID).Count(&fileLinkCount)
	if fileLinkCount != 0 {
		t.Errorf("expected 0 message_file links, got %d", fileLinkCount)
	}
}

func TestDeleteChatRejectsPrivate(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	chat, _ := s.CreateChat("alice:test", "bob:test")

	if err := s.DeleteChat(chat.ID); err == nil {
		t.Error("expected error deleting private chat")
	}
}

func TestGetChatsByAvatarFileID(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	s.CreateUser("bob:test", "bob")
	s.CreateUser("carol:test", "carol")
	f, _ := s.SaveFile("avatar-hash", "image/png", 100, "a.png", "a.png")

	chat, _ := s.CreateGroupChat("G", "alice:test", []string{"bob:test", "carol:test"})
	if _, err := s.UpdateChatAvatar(chat.ID, f.ID); err != nil {
		t.Fatalf("set avatar: %v", err)
	}

	ids, err := s.GetChatsByAvatarFileID(f.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(ids) != 1 || ids[0] != chat.ID {
		t.Errorf("expected [%s], got %v", chat.ID, ids)
	}

	ids, err = s.GetChatsByAvatarFileID("nonexistent")
	if err != nil {
		t.Fatalf("get nonexistent: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty, got %v", ids)
	}
}

func TestAddThreadMessage(t *testing.T) {
	s := newTestStore(t)
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
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")
	user, _ := s.GetUserByID("alice:test")

	if !user.Online {
		t.Error("expected user to be online after creation")
	}

	s.AddConnection("alice:test")

	s.RemoveConnection("alice:test")

	user, _ = s.GetUserByID("alice:test")
	if user.Online {
		t.Error("expected user to be offline after RemoveConnection")
	}
}

func TestAddConnectionMultiple(t *testing.T) {
	s := newTestStore(t)
	s.CreateUser("alice:test", "alice")

	s.AddConnection("alice:test")
	s.AddConnection("alice:test")
	s.RemoveConnection("alice:test")

	user, _ := s.GetUserByID("alice:test")
	if !user.Online {
		t.Error("expected user to stay online after one RemoveConnection (still one left)")
	}

	s.RemoveConnection("alice:test")

	user, _ = s.GetUserByID("alice:test")
	if user.Online {
		t.Error("expected user to be offline after all connections removed")
	}
}

func TestGetMessageValue(t *testing.T) {
	s := newTestStore(t)
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

	msg1.Text = "modified" //nolint:goconst // test value
	if msg2.Text == "modified" {
		t.Error("GetMessage should return a copy, modifications to one should not affect the other")
	}
}

func TestGetThreadValue(t *testing.T) {
	s := newTestStore(t)
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
