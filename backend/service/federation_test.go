package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

func newFedTestService(t *testing.T) *Service {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{},
	); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server:   config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:     config.CORSConfig{Origin: "*"},
		Database: config.DatabaseConfig{Path: ":memory:"},
	}

	return New(store.New(db), cfg, sse.NewHub(time.Minute), nil)
}

func TestUserIDBelongsToServer(t *testing.T) {
	cases := []struct {
		userID, server string
		want           bool
	}{
		{"user:remote.test", "remote.test", true},
		{"user:remote.test", "other.test", false},
		{"localuser", "remote.test", false},
		{"trailing:", "remote.test", false},
		{"nocolon", "", false},
		{"", "remote.test", false},
	}
	for _, c := range cases {
		if got := UserIDBelongsToServer(c.userID, c.server); got != c.want {
			t.Errorf("UserIDBelongsToServer(%q,%q)=%v want %v", c.userID, c.server, got, c.want)
		}
	}
}

func TestFederatedChatMembersValid(t *testing.T) {
	cases := []struct {
		members       []string
		remote, local string
		want          bool
	}{
		{[]string{"a:loc", "b:rem"}, "rem", "loc", true},
		{[]string{"a:loc", "b:rem"}, "loc", "rem", true},
		{[]string{"a:rem", "b:rem"}, "rem", "loc", false},
		{[]string{"a:loc", "b:loc"}, "rem", "loc", false},
		{[]string{"a:rem", "b:third"}, "rem", "loc", false},
		{[]string{"a:rem"}, "rem", "loc", false},
		{[]string{"a:rem", "b:loc", "c:rem"}, "rem", "loc", false},
		{[]string{"a:rem", "b:loc"}, "", "loc", false},
		{[]string{"a:rem", "b:loc"}, "rem", "", false},
	}
	for _, c := range cases {
		if got := FederatedChatMembersValid(c.members, c.remote, c.local); got != c.want {
			t.Errorf("FederatedChatMembersValid(%v,%q,%q)=%v want %v", c.members, c.remote, c.local, got, c.want)
		}
	}
}

func TestValidFileIDs(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	f1, err := s.store.SaveFile(ctx, "h1", "text/plain", 10, "a.txt", "/tmp/a.txt")
	if err != nil {
		t.Fatal(err)
	}

	f2, err := s.store.SaveFile(ctx, "h2", "text/plain", 20, "b.txt", "/tmp/b.txt")
	if err != nil {
		t.Fatal(err)
	}

	valid := s.ValidFileIDs(ctx, []string{f1.ID, "nope", f2.ID})
	if len(valid) != 2 || valid[0] != f1.ID || valid[1] != f2.ID {
		t.Errorf("unexpected valid IDs: %v", valid)
	}

	if empty := s.ValidFileIDs(ctx, []string{"zz"}); len(empty) != 0 {
		t.Errorf("expected empty, got %v", empty)
	}
}

func TestCreateFederatedChat_Validation(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	// Wrong member count.
	if _, _, err := s.CreateFederatedChat(ctx, "c1", []string{"a:rem"}, "rem", "loc"); !errors.Is(err, ErrFederatedChatMembers) {
		t.Errorf("expected ErrFederatedChatMembers, got %v", err)
	}

	// Members not split across servers.
	if _, _, err := s.CreateFederatedChat(ctx, "c1", []string{"a:rem", "b:rem"}, "rem", "loc"); !errors.Is(err, ErrFederatedMembersNotValid) {
		t.Errorf("expected ErrFederatedMembersNotValid, got %v", err)
	}
}

func TestCreateFederatedChat_SuccessAndIdempotent(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	view1, already, err := s.CreateFederatedChat(ctx, "c1", []string{"a:loc", "b:rem"}, "rem", "loc")
	if err != nil {
		t.Fatal(err)
	}
	if already {
		t.Fatal("expected first creation to be new")
	}
	if view1.ID != "c1" {
		t.Errorf("expected chat id c1, got %q", view1.ID)
	}

	// Second call with the same id is idempotent.
	if _, already, err := s.CreateFederatedChat(ctx, "c1", []string{"a:loc", "b:rem"}, "rem", "loc"); err != nil {
		t.Fatal(err)
	} else if !already {
		t.Fatal("expected second creation to be idempotent")
	}
}

func TestSearchFederatedUsers(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	// Too short query returns empty, non-nil.
	if got := s.SearchFederatedUsers(ctx, "a"); len(got) != 0 {
		t.Errorf("expected empty for short query, got %v", got)
	}

	if _, err := s.store.CreateUser(ctx, "a@t.local", "alice", "loc", time.Hour); err != nil {
		t.Fatal(err)
	}

	got := s.SearchFederatedUsers(ctx, "ali")
	if len(got) != 1 || got[0].Nick != "alice" {
		t.Errorf("expected alice, got %v", got)
	}
}

func TestSendFederatedMessage_Success(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{
		ID:           "c1",
		Members:      []string{"a:loc", "b:rem"},
		RemoteServer: "rem",
		CreatedAt:    time.Now(),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	msg, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID:       "m1",
		FromID:   "b:rem",
		FromNick: "remote",
		Text:     "hello",
	}, MaxMessageLen)
	if err != nil {
		t.Fatal(err)
	}
	if msg.ID != "m1" || msg.Text != "hello" {
		t.Errorf("unexpected message: %+v", msg)
	}

	// Reply enrichment.
	parent := &model.Message{ID: "p1", ChatID: "c1", FromID: "a:loc", FromNick: "local", Text: "parent", CreatedAt: time.Now()}
	if err := s.store.AddRawMessage(ctx, parent); err != nil {
		t.Fatal(err)
	}

	reply, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID:        "m2",
		FromID:    "b:rem",
		FromNick:  "remote",
		Text:      "reply",
		ReplyToID: "p1",
	}, MaxMessageLen)
	if err != nil {
		t.Fatal(err)
	}
	if reply.ReplyTo == nil || reply.ReplyTo.Text != "parent" {
		t.Errorf("expected reply enrichment, got %+v", reply.ReplyTo)
	}
}

func TestSendFederatedMessage_Validation(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	// fromId not from remote server.
	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{ID: "m1", FromID: "a:loc", Text: "x"}, MaxMessageLen); !errors.Is(err, ErrFederatedFromNotRemote) {
		t.Errorf("expected ErrFederatedFromNotRemote, got %v", err)
	}

	// Missing id.
	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{FromID: "b:rem", Text: "x"}, MaxMessageLen); !errors.Is(err, ErrFederatedIDRequired) {
		t.Errorf("expected ErrFederatedIDRequired, got %v", err)
	}

	// Empty text.
	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{ID: "m1", FromID: "b:rem", Text: "  "}, MaxMessageLen); !errors.Is(err, ErrEmptyMessage) {
		t.Errorf("expected ErrEmptyMessage, got %v", err)
	}

	// Too long.
	long := make([]rune, MaxMessageLen+1)
	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{ID: "m1", FromID: "b:rem", Text: string(long)}, MaxMessageLen); !errors.Is(err, ErrMessageTooLong) {
		t.Errorf("expected ErrMessageTooLong, got %v", err)
	}
}

func TestDeleteFederatedMessage_Success(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "b:rem", FromNick: "remote", Text: "hi", CreatedAt: time.Now()}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteFederatedMessage(ctx, chat, "m1", 0); err != nil {
		t.Fatal(err)
	}

	if _, err := s.store.GetMessage(ctx, "c1", "m1"); err == nil {
		t.Error("expected message to be deleted")
	}
}

func TestDeleteFederatedMessage_AuthorNotRemote(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "a:loc", FromNick: "local", Text: "hi", CreatedAt: time.Now()}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteFederatedMessage(ctx, chat, "m1", 0); !errors.Is(err, ErrFederatedAuthorNotRemote) {
		t.Errorf("expected ErrFederatedAuthorNotRemote, got %v", err)
	}
}

func TestSyncFederated(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "b:rem", FromNick: "remote", Text: "hi", CreatedAt: now, UpdatedAt: now}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	resp := s.SyncFederated(ctx, "rem", now.Add(-time.Hour))
	if len(resp.Messages) != 1 || resp.Messages[0].ID != "m1" {
		t.Errorf("expected one message m1, got %v", resp.Messages)
	}
	if len(resp.DeletedMessages) != 0 {
		t.Errorf("expected no deleted messages, got %v", resp.DeletedMessages)
	}
}
