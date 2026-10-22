package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/model"
)

const (
	testAlice  = "alice:test"
	testBob    = "bob:test"
	testCarol  = "carol:test"
	testEdited = "Edited!"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}, &model.FederationOp{}, &model.FederationCursor{}); err != nil {
		t.Fatal(err)
	}

	return New(db)
}

func createTestUser(t *testing.T, s *Store, nick string) *model.User {
	t.Helper()
	user, err := s.CreateUser(context.Background(), nick+"@test.local", nick, "test", 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestCreateUser(t *testing.T) {
	s := newTestStore(t)

	user, err := s.CreateUser(context.Background(), "alice@test.local", "alice", "localhost:8080", 24*time.Hour)
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

	_, err = s.CreateUser(context.Background(), "alice@test.local", "alice", "localhost:8080", 24*time.Hour)
	if err == nil {
		t.Error("expected error for duplicate nick")
	}
}

func TestGetUserByToken(t *testing.T) {
	s := newTestStore(t)

	user := createTestUser(t, s, "bob")
	found, ok := s.GetUserByToken(context.Background(), user.Token)
	if !ok {
		t.Fatal("expected to find user by token")
	}
	if found.ID != user.ID {
		t.Errorf("expected %s, got %s", user.ID, found.ID)
	}

	_, ok = s.GetUserByToken(context.Background(), "invalid-token")
	if ok {
		t.Error("expected false for invalid token")
	}
}

func TestGetUserByID(t *testing.T) {
	s := newTestStore(t)

	user := createTestUser(t, s, "carol")
	found, ok := s.GetUserByID(context.Background(), user.ID)
	if !ok {
		t.Fatal("expected to find user by ID")
	}
	if found.Nick != "carol" {
		t.Errorf("expected carol, got %s", found.Nick)
	}
}

func TestSearchUsers(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "dalia")

	results := s.SearchUsers(context.Background(), "ali", "")
	if len(results) != 2 {
		t.Errorf("expected 2 results (alice, dalia), got %d", len(results))
	}

	results = s.SearchUsers(context.Background(), "bob", "")
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}

	results = s.SearchUsers(context.Background(), "xyz", "")
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}

	results = s.SearchUsers(context.Background(), "ali", testAlice)
	if len(results) != 1 {
		t.Errorf("expected 1 result (dalia excluding alice), got %d", len(results))
	}
}

func TestCreateChat(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, err := s.CreateChat(context.Background(), testAlice, testBob, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(chat.Members) != 2 {
		t.Errorf("expected 2 members, got %d", len(chat.Members))
	}

	same, err := s.CreateChat(context.Background(), testAlice, testBob, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if same.ID != chat.ID {
		t.Error("expected same chat ID for existing conversation")
	}
}

func TestGetUserChats(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	s.CreateChat(context.Background(), testAlice, testBob, "")
	s.CreateChat(context.Background(), testAlice, testCarol, "")

	chats := s.GetUserChats(context.Background(), testAlice)
	if len(chats) != 2 {
		t.Errorf("expected 2 chats, got %d", len(chats))
	}

	chats = s.GetUserChats(context.Background(), testBob)
	if len(chats) != 1 {
		t.Errorf("expected 1 chat, got %d", len(chats))
	}
}

func TestAddMessage(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	msg, _, err := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello!", "", "", nil, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if msg.Text != "Hello!" {
		t.Errorf("expected 'Hello!', got '%s'", msg.Text)
	}
	if msg.FromID != testAlice {
		t.Errorf("expected alice:test, got %s", msg.FromID)
	}
	if msg.ChatID != chat.ID {
		t.Errorf("expected %s, got %s", chat.ID, msg.ChatID)
	}

	_, _, err = s.AddMessage(context.Background(), "nonexistent", "", testAlice, "alice", "test", "", "", nil, false, "")
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestEditMessage(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "", "", nil, false, "")

	updated, err := s.EditMessage(context.Background(), chat.ID, "", msg.ID, testAlice, testEdited, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Text != testEdited {
		t.Errorf("expected 'Edited!', got '%s'", updated.Text)
	}
	if updated.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	_, err = s.EditMessage(context.Background(), chat.ID, "", msg.ID, testBob, "Hacked!", nil, false, nil, nil)
	if err == nil {
		t.Error("expected error when bob edits alice's message")
	}
}

func TestDeleteMessage(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "", "", nil, false, "")

	err := s.DeleteMessage(context.Background(), chat.ID, msg.ID, testAlice)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	err = s.DeleteMessage(context.Background(), chat.ID, "nonexistent", testAlice)
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestSetMessageFiles(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "", "", nil, false, "")

	f1, _ := s.SaveFile(context.Background(), "hash1", "image/png", 100, "a.png", "a.png", "alice:local")
	f2, _ := s.SaveFile(context.Background(), "hash2", "application/pdf", 200, "b.pdf", "b.pdf", "alice:local")
	f3, _ := s.SaveFile(context.Background(), "hash3", "text/plain", 50, "c.txt", "c.txt", "alice:local")

	if err := s.AddMessageFiles(context.Background(), msg.ID, []string{f1.ID, f2.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := s.SetMessageFiles(context.Background(), msg.ID, []string{f2.ID, f3.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	files, err := s.GetMessageFiles(context.Background(), msg.ID)
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

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	parent, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "parent", "", "", nil, false, "")
	thread, _ := s.CreateThread(context.Background(), chat.ID, parent.ID, parent.Text, parent.FromNick)
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, thread.ID, testAlice, "alice", "Hello", "", "", nil, false, "")

	updated, err := s.EditMessage(context.Background(), chat.ID, thread.ID, msg.ID, testAlice, testEdited, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Text != testEdited {
		t.Errorf("expected 'Edited!', got '%s'", updated.Text)
	}
	if updated.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	_, err = s.EditMessage(context.Background(), chat.ID, thread.ID, msg.ID, testBob, "Hacked!", nil, false, nil, nil)
	if err == nil {
		t.Error("expected error when bob edits alice's thread message")
	}

	_, err = s.EditMessage(context.Background(), "", "nonexistent", msg.ID, testAlice, "x", nil, false, nil, nil)
	if err == nil {
		t.Error("expected error for nonexistent thread")
	}
}

func TestMessageLocation(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	loc := &model.Location{Lat: 51.505, Lng: -0.09}
	msg, _, err := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Meet here", "", "", loc, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if msg.Location == nil {
		t.Fatal("expected location to be set on the new message")
	}
	if msg.Location.Lat != 51.505 || msg.Location.Lng != -0.09 {
		t.Errorf("unexpected coords: %+v", msg.Location)
	}

	// Reading from DB should preserve the location.
	loaded, err := s.GetMessage(context.Background(), chat.ID, msg.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if loaded.Location == nil {
		t.Fatal("expected location to round-trip through the DB")
	}
	if loaded.Location.Lat != 51.505 || loaded.Location.Lng != -0.09 {
		t.Errorf("unexpected round-tripped coords: %+v", loaded.Location)
	}
}

func TestEditMessageLocation(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "x", "", "", nil, false, "")

	// Set initial location.
	updated, err := s.EditMessage(context.Background(), chat.ID, "", msg.ID, testAlice, "x", &model.Location{Lat: 1, Lng: 2}, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Location == nil || updated.Location.Lat != 1 || updated.Location.Lng != 2 {
		t.Errorf("expected location to be set, got %+v", updated.Location)
	}

	// Replace with a different location.
	updated, err = s.EditMessage(context.Background(), chat.ID, "", msg.ID, testAlice, "x", &model.Location{Lat: 3, Lng: 4}, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Location == nil || updated.Location.Lat != 3 || updated.Location.Lng != 4 {
		t.Errorf("expected replaced location, got %+v", updated.Location)
	}

	// Clear the location.
	updated, err = s.EditMessage(context.Background(), chat.ID, "", msg.ID, testAlice, "x", nil, true, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Location != nil {
		t.Errorf("expected location to be cleared, got %+v", updated.Location)
	}

	// Leave unchanged (no location params).
	updated, err = s.EditMessage(context.Background(), chat.ID, "", msg.ID, testAlice, "new text", nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Location != nil {
		t.Errorf("expected location to remain nil, got %+v", updated.Location)
	}
}

func TestReplyToLocation(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	parent, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "x", "", "", &model.Location{Lat: 10, Lng: 20}, false, "")

	reply, _, err := s.AddMessage(context.Background(), chat.ID, "", testBob, "bob", "reply", "", parent.ID, nil, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if reply.ReplyTo == nil {
		t.Fatal("expected reply-to info to be set")
	}
	if reply.ReplyTo.Location == nil || reply.ReplyTo.Location.Lat != 10 || reply.ReplyTo.Location.Lng != 20 {
		t.Errorf("expected reply-to to carry parent location, got %+v", reply.ReplyTo.Location)
	}
}

func TestGetMessagesPaginated(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	for i := range 10 {
		s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", fmt.Sprintf("msg-%d", i), "", "", nil, false, "")
	}

	msgs, next, hasMore := s.GetMessagesPaginated(context.Background(), chat.ID, 4, "")
	if len(msgs) != 4 {
		t.Errorf("expected 4 messages, got %d", len(msgs))
	}
	if next == "" {
		t.Error("expected nextCursor for first page")
	}
	if !hasMore {
		t.Error("expected hasMore=true for first page")
	}

	msgs, _, hasMore = s.GetMessagesPaginated(context.Background(), chat.ID, 10, next)
	if len(msgs) != 6 {
		t.Errorf("expected 6 messages (remaining), got %d", len(msgs))
	}
	if hasMore {
		t.Error("expected hasMore=false after loading all")
	}

	msgs, _, _ = s.GetMessagesPaginated(context.Background(), chat.ID, 100, "")
	if len(msgs) != 10 {
		t.Errorf("expected all 10 messages, got %d", len(msgs))
	}
}

func TestCreateRemoteChat(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat := &model.Chat{
		ID:           "remote-chat-id",
		Members:      []string{"alice:local", "bob:remote"},
		CreatedAt:    time.Now(),
		RemoteServer: "remote.com",
	}

	s.CreateRemoteChat(context.Background(), chat)

	got, ok := s.GetChat(context.Background(), "remote-chat-id")
	if !ok {
		t.Fatal("expected to find remote chat")
	}
	if got.RemoteServer != "remote.com" {
		t.Errorf("expected RemoteServer=remote.com, got %s", got.RemoteServer)
	}
}

func TestAddRawMessage(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	msg := &model.Message{
		ID:     "raw-1",
		ChatID: chat.ID,
		FromID: testBob,
		Text:   "from remote",
	}

	err := s.AddRawMessage(context.Background(), msg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msgs, _, _ := s.GetMessagesPaginated(context.Background(), chat.ID, 100, "")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].ID != "raw-1" {
		t.Errorf("expected raw-1, got %s", msgs[0].ID)
	}

	err = s.AddRawMessage(context.Background(), &model.Message{ChatID: "nonexistent"})
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestEditRawMessage(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "msg-1", "", nil, false, "")

	now := time.Now()
	err := s.EditRawMessage(context.Background(), chat.ID, "msg-1", testEdited, now, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msg, err := s.GetMessage(context.Background(), chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}
	if msg.Text != testEdited {
		t.Errorf("expected 'Edited!', got '%s'", msg.Text)
	}
	if msg.EditedAt == nil {
		t.Error("expected EditedAt to be set")
	}

	err = s.EditRawMessage(context.Background(), chat.ID, "nonexistent", "", time.Now(), nil, false, nil, nil)
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestDeleteRawMessage(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "msg-1", "", nil, false, "")

	err := s.DeleteRawMessage(context.Background(), chat.ID, "msg-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msgs, _, _ := s.GetMessagesPaginated(context.Background(), chat.ID, 100, "")
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}

	err = s.DeleteRawMessage(context.Background(), chat.ID, "nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent message")
	}
}

func TestCreateThreadAndGet(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Parent", "parent-1", "", nil, false, "")

	thread, err := s.CreateThread(context.Background(), chat.ID, "parent-1", "Parent", "alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if thread.ParentMessageID != "parent-1" {
		t.Errorf("expected parent-1, got %s", thread.ParentMessageID)
	}

	got, ok := s.GetThread(context.Background(), thread.ID)
	if !ok {
		t.Fatal("expected to find thread")
	}
	if got.ID != thread.ID {
		t.Errorf("expected %s, got %s", thread.ID, got.ID)
	}

	byParent, ok := s.GetThreadByParentMessage(context.Background(), chat.ID, "parent-1")
	if !ok {
		t.Fatal("expected to find thread by parent message")
	}
	if byParent.ID != thread.ID {
		t.Errorf("expected %s, got %s", thread.ID, byParent.ID)
	}

	_, err = s.CreateThread(context.Background(), chat.ID, "parent-1", "Parent", "alice")
	if err == nil {
		t.Error("expected error for duplicate thread")
	}

	_, err = s.CreateThread(context.Background(), "nonexistent", "msg", "", "")
	if err == nil {
		t.Error("expected error for nonexistent chat")
	}
}

func TestGetThreadsForChat(t *testing.T) {
	s := newTestStore(t)

	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Msg1", "m1", "", nil, false, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Msg2", "m2", "", nil, false, "")

	s.CreateThread(context.Background(), chat.ID, "m1", "Msg1", "alice")
	s.CreateThread(context.Background(), chat.ID, "m2", "Msg2", "alice")

	threads := s.GetThreadsForChat(context.Background(), chat.ID)
	if len(threads) != 2 {
		t.Errorf("expected 2 threads, got %d", len(threads))
	}

	noThreads := s.GetThreadsForChat(context.Background(), "nonexistent")
	if len(noThreads) != 0 {
		t.Errorf("expected 0 threads, got %d", len(noThreads))
	}
}

func TestCreateChatIsPrivate(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, err := s.CreateChat(context.Background(), testAlice, testBob, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "private" {
		t.Errorf("expected type=private, got %q", chat.Type)
	}
}

func TestCreateGroupChatBasic(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, err := s.CreateGroupChat(context.Background(), "Team", testAlice, []string{testBob, testCarol}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "group" {
		t.Errorf("expected type=group, got %q", chat.Type)
	}
	if chat.Name != "Team" {
		t.Errorf("expected name=Team, got %q", chat.Name)
	}
	if chat.OwnerID != testAlice {
		t.Errorf("expected ownerId=alice:test, got %q", chat.OwnerID)
	}
	if len(chat.Members) != 3 {
		t.Errorf("expected 3 members, got %d", len(chat.Members))
	}
}

func TestCreateGroupChatUnlimitedDuplicates(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	c1, _ := s.CreateGroupChat(context.Background(), "G1", testAlice, []string{testBob, testCarol}, "")
	c2, _ := s.CreateGroupChat(context.Background(), "G2", testAlice, []string{testBob, testCarol}, "")
	c3, _ := s.CreateGroupChat(context.Background(), "G3", testAlice, []string{testBob, testCarol}, "")

	if c1.ID == c2.ID || c2.ID == c3.ID || c1.ID == c3.ID {
		t.Errorf("expected 3 distinct IDs, got %s %s %s", c1.ID, c2.ID, c3.ID)
	}

	chats := s.GetUserChats(context.Background(), testAlice)
	if len(chats) != 3 {
		t.Errorf("expected 3 chats for alice, got %d", len(chats))
	}
}

func TestCreateGroupChatDeduplicates(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, err := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testAlice, testBob, testCarol}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(chat.Members) != 3 {
		t.Errorf("expected 3 unique members (dedup alice), got %d", len(chat.Members))
	}
}

func TestCreateGroupChatValidation(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	// owner + bob = 2 members, valid
	chat, err := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testAlice, testBob}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(chat.Members) != 2 {
		t.Errorf("expected 2 unique members, got %d", len(chat.Members))
	}
}

func TestCreateGroupChatSolo(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")

	chat, err := s.CreateGroupChat(context.Background(), "Solo", testAlice, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if chat.Type != "group" {
		t.Errorf("expected type=group, got %q", chat.Type)
	}
	if chat.OwnerID != testAlice {
		t.Errorf("expected ownerId=alice:test, got %q", chat.OwnerID)
	}
	if len(chat.Members) != 1 {
		t.Errorf("expected 1 member (owner only), got %d", len(chat.Members))
	}
}

func TestAddChatMember(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")
	createTestUser(t, s, "dave")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob, testCarol}, "")

	if err := s.AddChatMember(context.Background(), chat.ID, "dave:test", 100); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, _ := s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 4 {
		t.Errorf("expected 4 members, got %d", len(got.Members))
	}

	if err := s.AddChatMember(context.Background(), chat.ID, "dave:test", 100); err != nil {
		t.Errorf("idempotent add should not error: %v", err)
	}

	got, _ = s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 4 {
		t.Errorf("expected still 4 members after duplicate add, got %d", len(got.Members))
	}

	privateChat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	if err := s.AddChatMember(context.Background(), privateChat.ID, testCarol, 100); err == nil {
		t.Error("expected error adding member to private chat")
	}
}

func TestAddChatMemberEnforcesLimit(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob}, "")

	// maxMembers=2: owner + bob already fill the group.
	createTestUser(t, s, "carol")
	if err := s.AddChatMember(context.Background(), chat.ID, testCarol, 2); err == nil {
		t.Error("expected error when adding member beyond the limit")
	}

	got, _ := s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 2 {
		t.Errorf("expected 2 members after rejected add, got %d", len(got.Members))
	}
}

func TestRemoveChatMember(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob, testCarol}, "")

	if err := s.RemoveChatMember(context.Background(), chat.ID, testBob); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, _ := s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 2 {
		t.Errorf("expected 2 members, got %d", len(got.Members))
	}

	if err := s.RemoveChatMember(context.Background(), chat.ID, testCarol); err != nil {
		t.Fatalf("unexpected error removing carol: %v", err)
	}

	got, _ = s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 1 {
		t.Errorf("expected 1 member remaining, got %d", len(got.Members))
	}

	if err := s.RemoveChatMember(context.Background(), chat.ID, testAlice); err == nil {
		t.Error("expected error: cannot remove the last member")
	}

	if err := s.RemoveChatMember(context.Background(), chat.ID, "nobody:test"); err == nil {
		t.Error("expected error: removing nonexistent user should not error silently")
	}
}

func TestUpdateChatName(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, _ := s.CreateGroupChat(context.Background(), "Old", testAlice, []string{testBob, testCarol}, "")

	updated, err := s.UpdateChatName(context.Background(), chat.ID, "New")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Name != "New" {
		t.Errorf("expected New, got %q", updated.Name)
	}

	privateChat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	if _, err := s.UpdateChatName(context.Background(), privateChat.ID, "X"); err == nil {
		t.Error("expected error renaming private chat")
	}
}

func TestUpdateChatAvatar(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")
	f, _ := s.SaveFile(context.Background(), "hash", "image/png", 100, "a.png", "a.png", "alice:local")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob, testCarol}, "")

	updated, err := s.UpdateChatAvatar(context.Background(), chat.ID, f.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.AvatarFileID != f.ID {
		t.Errorf("expected avatar %s, got %q", f.ID, updated.AvatarFileID)
	}
}

func TestDeleteChatCascade(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob, testCarol}, "")
	msg, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "hi", "", "", nil, false, "")
	thread, _ := s.CreateThread(context.Background(), chat.ID, msg.ID, "hi", "alice")
	s.AddMessage(context.Background(), chat.ID, thread.ID, testBob, "bob", "reply", "", "", nil, false, "")
	f, _ := s.SaveFile(context.Background(), "h", "image/png", 1, "a.png", "a.png", "alice:local")
	s.AddMessageFiles(context.Background(), msg.ID, []string{f.ID})

	if err := s.DeleteChat(context.Background(), chat.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, ok := s.GetChat(context.Background(), chat.ID); ok {
		t.Error("expected chat to be deleted")
	}

	if msgs, _, _ := s.GetMessagesPaginated(context.Background(), chat.ID, 100, ""); len(msgs) != 0 {
		t.Errorf("expected 0 messages, got %d", len(msgs))
	}

	if threads := s.GetThreadsForChat(context.Background(), chat.ID); len(threads) != 0 {
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
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	if err := s.DeleteChat(context.Background(), chat.ID); err == nil {
		t.Error("expected error deleting private chat")
	}
}

func TestGetChatsByAvatarFileID(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")
	f, _ := s.SaveFile(context.Background(), "avatar-hash", "image/png", 100, "a.png", "a.png", "alice:local")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob, testCarol}, "")
	if _, err := s.UpdateChatAvatar(context.Background(), chat.ID, f.ID); err != nil {
		t.Fatalf("set avatar: %v", err)
	}

	ids, err := s.GetChatsByAvatarFileID(context.Background(), f.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(ids) != 1 || ids[0] != chat.ID {
		t.Errorf("expected [%s], got %v", chat.ID, ids)
	}

	ids, err = s.GetChatsByAvatarFileID(context.Background(), "nonexistent")
	if err != nil {
		t.Fatalf("get nonexistent: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty, got %v", ids)
	}
}

func TestAddThreadMessage(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Parent", "parent-1", "", nil, false, "")
	thread, _ := s.CreateThread(context.Background(), chat.ID, "parent-1", "Parent", "alice")

	msg, _, err := s.AddMessage(context.Background(), chat.ID, thread.ID, testBob, "bob", "Reply", "", "", nil, false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg.Text != "Reply" {
		t.Errorf("expected 'Reply', got '%s'", msg.Text)
	}

	got, ok := s.GetThread(context.Background(), thread.ID)
	if !ok {
		t.Fatal("expected to find thread")
	}
	if got.MessageCount != 1 {
		t.Errorf("expected MessageCount=1, got %d", got.MessageCount)
	}

	msgs, _, _ := s.GetThreadMessagesPaginated(context.Background(), thread.ID, 10, "")
	if len(msgs) != 1 {
		t.Errorf("expected 1 thread message, got %d", len(msgs))
	}

	_, _, err = s.AddMessage(context.Background(), "", "nonexistent", testAlice, "alice", "test", "", "", nil, false, "")
	if err == nil {
		t.Error("expected error for nonexistent thread")
	}
}

func TestAddConnection(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")

	if s.IsOnline(testAlice) {
		t.Error("expected user to be offline right after creation")
	}

	s.AddConnection(testAlice)

	if !s.IsOnline(testAlice) {
		t.Error("expected user to be online after AddConnection")
	}

	s.RemoveConnection(testAlice)

	if s.IsOnline(testAlice) {
		t.Error("expected user to be offline after RemoveConnection")
	}
}

func TestAddConnectionMultiple(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")

	s.AddConnection(testAlice)
	s.AddConnection(testAlice)
	s.RemoveConnection(testAlice)

	if !s.IsOnline(testAlice) {
		t.Error("expected user to stay online after one RemoveConnection (still one left)")
	}

	s.RemoveConnection(testAlice)

	if s.IsOnline(testAlice) {
		t.Error("expected user to be offline after all connections removed")
	}
}

func TestOfflineSince(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")

	// A user that did not connect is not offline: the zero time says
	// nothing about it.
	if since := s.OfflineSince(testAlice); !since.IsZero() {
		t.Fatalf("offlineSince = %v, want the zero time", since)
	}

	s.AddConnection(testAlice)
	s.AddConnection(testAlice)
	s.RemoveConnection(testAlice)

	// One connection is left: the user is still online.
	if since := s.OfflineSince(testAlice); !since.IsZero() {
		t.Fatalf("offlineSince = %v with a connection left, want the zero time", since)
	}

	before := time.Now()
	s.RemoveConnection(testAlice)

	since := s.OfflineSince(testAlice)
	if since.IsZero() || since.Before(before) {
		t.Fatalf("offlineSince = %v, want the time the user went offline", since)
	}

	s.AddConnection(testAlice)

	if since := s.OfflineSince(testAlice); !since.IsZero() {
		t.Fatalf("offlineSince = %v after reconnecting, want the zero time", since)
	}
}

func TestGetMessageValue(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Hello", "msg-1", "", nil, false, "")

	msg1, err := s.GetMessage(context.Background(), chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	msg2, err := s.GetMessage(context.Background(), chat.ID, "msg-1")
	if err != nil {
		t.Fatal(err)
	}

	msg1.Text = "modified"
	if msg2.Text == "modified" {
		t.Error("GetMessage should return a copy, modifications to one should not affect the other")
	}
}

func TestGetThreadValue(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")
	s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "Parent", "parent-1", "", nil, false, "")
	s.CreateThread(context.Background(), chat.ID, "parent-1", "Parent", "alice")

	threads := s.GetThreadsForChat(context.Background(), chat.ID)
	thread1, _ := s.GetThread(context.Background(), threads[0].ID)
	thread2, _ := s.GetThread(context.Background(), threads[0].ID)

	thread1.ChatID = "modified"
	if thread2.ChatID == "modified" {
		t.Error("GetThread should return a copy")
	}
}

func TestAddRawMessageIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	msg := &model.Message{
		ID:     "dup-1",
		ChatID: chat.ID,
		FromID: testBob,
		Text:   "original",
	}

	if err := s.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatalf("first insert: %v", err)
	}

	// A federated retry with the same ID should not error.
	msg.Text = "replay"
	if err := s.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatalf("second insert (replay): %v", err)
	}

	msgs, _, _ := s.GetMessagesPaginated(context.Background(), chat.ID, 100, "")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message after replay, got %d", len(msgs))
	}
	if msgs[0].Text != "original" {
		t.Errorf("replay overwrote original text: %q", msgs[0].Text)
	}
}

func TestSearchUsersOnlineState(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	if s.IsOnline(testAlice) {
		t.Fatal("alice should start offline")
	}

	s.AddConnection(testAlice)

	results := s.SearchUsers(context.Background(), "ali", "")
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if !results[0].Online {
		t.Error("expected alice to appear online in search results")
	}

	results = s.SearchUsers(context.Background(), "bob", "")
	if len(results) != 1 {
		t.Fatalf("expected 1 bob result, got %d", len(results))
	}
	if results[0].Online {
		t.Error("bob has no connection, must be offline")
	}
}

func TestGetMessageFilesBatch(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	chat, _ := s.CreateChat(context.Background(), testAlice, testBob, "")

	m1, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "with file 1", "m-1", "", nil, false, "")
	m2, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "with two files", "m-2", "", nil, false, "")
	m3, _, _ := s.AddMessage(context.Background(), chat.ID, "", testAlice, "alice", "no file", "m-3", "", nil, false, "")

	f1, _ := s.SaveFile(context.Background(), "h1", "text/plain", 10, "a.txt", "a.txt", "alice:local")
	f2, _ := s.SaveFile(context.Background(), "h2", "text/plain", 20, "b.txt", "b.txt", "alice:local")

	if err := s.AddMessageFiles(context.Background(), m1.ID, []string{f1.ID}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddMessageFiles(context.Background(), m2.ID, []string{f1.ID, f2.ID}); err != nil {
		t.Fatal(err)
	}

	files, err := s.GetMessageFilesBatch(context.Background(), []string{m1.ID, m2.ID, m3.ID})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got := len(files[m1.ID]); got != 1 {
		t.Errorf("m1: expected 1 file, got %d", got)
	}
	if got := len(files[m2.ID]); got != 2 {
		t.Errorf("m2: expected 2 files, got %d", got)
	}
	if _, ok := files[m3.ID]; ok {
		t.Errorf("m3 should not have any files entry, got %v", files[m3.ID])
	}
}

func TestGetMessageFilesBatchEmpty(t *testing.T) {
	s := newTestStore(t)

	files, err := s.GetMessageFilesBatch(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("expected empty map, got %d entries", len(files))
	}
}

func TestGetUsersByIDs(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")
	createTestUser(t, s, "carol")

	got := s.GetUsersByIDs(context.Background(), []string{testAlice, testBob, "nonexistent"})
	if got[testAlice] != "alice" {
		t.Errorf("alice: got %q, want %q", got[testAlice], "alice")
	}
	if got[testBob] != "bob" {
		t.Errorf("bob: got %q, want %q", got[testBob], "bob")
	}
	if _, ok := got["nonexistent"]; ok {
		t.Error("nonexistent id should not be in the map")
	}
}

func TestGetUsersByIDsEmpty(t *testing.T) {
	s := newTestStore(t)

	got := s.GetUsersByIDs(context.Background(), nil)
	if got == nil {
		t.Error("expected non-nil map")
	}
	if len(got) != 0 {
		t.Errorf("expected empty map, got %d entries", len(got))
	}
}

// TestDeleteChatHandlesMoreMessagesThanSQLiteHasVariables covers both statements
// in the tombstone write for a large chat. The rows went out in one bulk insert
// binding three columns each, and the driver rejects a statement past 32766
// parameters — about 10900 messages for the insert, and 32766 for the IN list
// that clears the file links. The failure came from inside the transaction, so
// nothing was deleted and the chat could never be deleted at all, only retried
// into the same error.
//
// The count is set above both ceilings rather than just the first one, so a
// change that fixes only the insert still fails here.
func TestDeleteChatHandlesMoreMessagesThanSQLiteHasVariables(t *testing.T) {
	const messageCount = 34000

	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	ctx := context.Background()
	chat, err := s.CreateGroupChat(ctx, "big", testAlice, []string{testBob}, "")
	if err != nil {
		t.Fatal(err)
	}

	// Inserted directly and in batches: the point is the size of the chat, not
	// how the rows arrived.
	for start := 0; start < messageCount; start += 500 {
		rows := make([]model.Message, 0, 500)

		for i := start; i < start+500 && i < messageCount; i++ {
			rows = append(rows, model.Message{
				ID:        fmt.Sprintf("big-%d", i),
				ChatID:    chat.ID,
				FromID:    testAlice,
				FromNick:  "alice",
				Text:      "x",
				CreatedAt: time.Now().UTC(),
			})
		}

		if err := s.db.CreateInBatches(rows, 500).Error; err != nil {
			t.Fatalf("seeding message %d: %v", start, err)
		}
	}

	if err := s.DeleteChat(ctx, chat.ID); err != nil {
		t.Fatalf("DeleteChat on a chat with %d messages: %v", messageCount, err)
	}

	if _, ok := s.GetChat(ctx, chat.ID); ok {
		t.Error("the chat survived deletion")
	}

	var remaining int64
	if err := s.db.Model(&model.Message{}).Where("chat_id = ?", chat.ID).Count(&remaining).Error; err != nil {
		t.Fatal(err)
	}

	if remaining != 0 {
		t.Errorf("%d messages survived", remaining)
	}

	// A tombstone per message, so the federated peers that had already seen
	// them do not resync them.
	var tombstones int64
	if err := s.db.Model(&model.DeletedMessage{}).Where("chat_id = ?", chat.ID).Count(&tombstones).Error; err != nil {
		t.Fatal(err)
	}

	if tombstones != messageCount {
		t.Errorf("tombstones = %d, want %d", tombstones, messageCount)
	}
}

// A member that was removed has to learn about it through the sync delta:
// without a tombstone the chat would stay in the local list forever.
func TestRemoveChatMemberLeavesATombstone(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob}, "")

	if err := s.RemoveChatMember(context.Background(), chat.ID, testBob); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tombs := s.DeletedChatsSince(context.Background(), testBob, time.Now().UTC().Add(-time.Hour))
	if len(tombs) != 1 || tombs[0].ChatID != chat.ID {
		t.Fatalf("expected a tombstone for the removed member, got %+v", tombs)
	}

	// The other members keep the chat.
	if tombs := s.DeletedChatsSince(context.Background(), testAlice, time.Now().UTC().Add(-time.Hour)); len(tombs) != 0 {
		t.Fatalf("expected no tombstone for a member that stayed, got %+v", tombs)
	}
}

// A member that leaves and comes back leaves a fresh tombstone: the second
// removal has to reach a client whose cursor is past the first one.
func TestRemoveChatMemberRefreshesTheTombstone(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob}, "")

	if err := s.RemoveChatMember(context.Background(), chat.ID, testBob); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	first := s.DeletedChatsSince(context.Background(), testBob, time.Now().UTC().Add(-time.Hour))
	if len(first) != 1 {
		t.Fatalf("expected a tombstone, got %+v", first)
	}

	if err := s.AddChatMember(context.Background(), chat.ID, testBob, 100); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := s.RemoveChatMember(context.Background(), chat.ID, testBob); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	second := s.DeletedChatsSince(context.Background(), testBob, first[0].DeletedAt)
	if len(second) != 1 {
		t.Fatalf("expected a fresh tombstone, got %+v", second)
	}
}

// The federation replaces the membership of a chat when the peer reports a
// change. A member that is dropped has to leave a tombstone, the same way a
// local removal does: without it the chat would stay in the local list of
// the removed member forever.
func TestReplaceChatMembersLeavesATombstone(t *testing.T) {
	s := newTestStore(t)
	createTestUser(t, s, "alice")
	createTestUser(t, s, "bob")

	chat, _ := s.CreateGroupChat(context.Background(), "G", testAlice, []string{testBob}, "")

	if err := s.ReplaceChatMembers(context.Background(), chat.ID, []string{testAlice}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, _ := s.GetChat(context.Background(), chat.ID)
	if len(got.Members) != 1 || got.Members[0] != testAlice {
		t.Fatalf("members = %v, want only alice", got.Members)
	}

	tombs := s.DeletedChatsSince(context.Background(), testBob, time.Now().UTC().Add(-time.Hour))
	if len(tombs) != 1 || tombs[0].ChatID != chat.ID {
		t.Fatalf("expected a tombstone for the removed member, got %+v", tombs)
	}
}
