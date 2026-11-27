package service

import (
	"context"
	"errors"
	"strings"
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
		&model.User{}, &model.Session{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.MessageReaction{}, &model.ReactionDeletion{}, &model.ChatPin{}, &model.UserBlock{}, &model.UserDevice{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{}, &model.FederationOp{}, &model.FederationCursor{},
		&model.MessageReadStatus{}, &model.FederationOp{}, &model.FederationCursor{},
		&model.AdminAuditLog{},
	); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server:   config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:     config.CORSConfig{Origin: "*"},
		Database: config.DatabaseConfig{Path: ":memory:"},
		Auth: config.AuthConfig{
			TokenExpiry:        24 * time.Hour,
			TokenExpiryWarning: 5 * time.Minute,
		},
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
		// Domain names legitimately contain colons (host:port); the domain
		// starts after the FIRST colon, matching RemoteServerFromID.
		{"user:localhost:8080", "localhost:8080", true},
		{"user:127.0.0.1:8081", "127.0.0.1:8081", true},
		{"user:127.0.0.1:8081", "8081", false},
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

func TestCreateFederatedChat_Validation(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	// Wrong member count.
	if _, _, err := s.CreateFederatedChat(ctx, "c1", []string{"a:rem"}, "rem", "loc", ""); !errors.Is(err, ErrFederatedChatMembers) {
		t.Errorf("expected ErrFederatedChatMembers, got %v", err)
	}

	// Members not split across servers.
	if _, _, err := s.CreateFederatedChat(ctx, "c1", []string{"a:rem", "b:rem"}, "rem", "loc", ""); !errors.Is(err, ErrFederatedMembersNotValid) {
		t.Errorf("expected ErrFederatedMembersNotValid, got %v", err)
	}
}

func TestCreateFederatedChat_SuccessAndIdempotent(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	view1, already, err := s.CreateFederatedChat(ctx, "c1", []string{"a:loc", "b:rem"}, "rem", "loc", "")
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
	if _, already, err := s.CreateFederatedChat(ctx, "c1", []string{"a:loc", "b:rem"}, "rem", "loc", ""); err != nil {
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
		CreatedAt:    time.Now().UTC(),
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
	parent := &model.Message{ID: "p1", ChatID: "c1", FromID: "a:loc", FromNick: "local", Text: "parent", CreatedAt: time.Now().UTC()}
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

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
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

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "b:rem", FromNick: "remote", Text: "hi", CreatedAt: time.Now().UTC()}
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

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "a:loc", FromNick: "local", Text: "hi", CreatedAt: time.Now().UTC()}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteFederatedMessage(ctx, chat, "m1", 0); !errors.Is(err, ErrFederatedAuthorNotRemote) {
		t.Errorf("expected ErrFederatedAuthorNotRemote, got %v", err)
	}
}

// TestFederatedPeerCannotEditOrDeleteLocalAuthor is the regression for the
// live-path hole: federatedChatForPeerAction clones a replica chat with
// FederatedPeer == RemoteServer == peer, which used to satisfy the relay
// branch of federatedAuthorAllowed for *local* authors too. A peer must never
// rewrite or erase the messages of our own users.
func TestFederatedPeerCannotEditOrDeleteLocalAuthor(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	localID := "alice:" + s.ServerDomain()

	chat := &model.Chat{
		ID:           "c1",
		Members:      []string{localID, "bob:peer"},
		RemoteServer: "peer",
		CreatedAt:    time.Now().UTC(),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}
	if err := s.store.AddRawMessage(ctx, &model.Message{
		ID: "m1", ChatID: "c1", FromID: localID, FromNick: "alice",
		Text: "mine", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	// The clone the inbound transport hands to the service for a live action.
	live := *chat
	live.FederatedPeer = "peer"

	if _, err := s.EditFederatedMessage(ctx, &live, "m1", "", &DecodedEditRequest{Text: "forged"}, 0); !errors.Is(err, ErrFederatedAuthorNotRemote) {
		t.Errorf("live edit of a local author: expected ErrFederatedAuthorNotRemote, got %v", err)
	}
	if err := s.DeleteFederatedMessage(ctx, &live, "m1", 0); !errors.Is(err, ErrFederatedAuthorNotRemote) {
		t.Errorf("live delete of a local author: expected ErrFederatedAuthorNotRemote, got %v", err)
	}

	// The catch-up path loads the chat without FederatedPeer. It must be just
	// as closed, both for the clone-free row and for a stale clone.
	if err := s.DeleteFederatedMessage(ctx, chat, "m1", 0); !errors.Is(err, ErrFederatedAuthorNotRemote) {
		t.Errorf("catch-up delete of a local author: expected ErrFederatedAuthorNotRemote, got %v", err)
	}

	stored, err := s.store.GetMessage(ctx, "c1", "m1")
	if err != nil {
		t.Fatalf("local message disappeared: %v", err)
	}
	if stored.Text != "mine" {
		t.Errorf("local message was rewritten: %q", stored.Text)
	}

	// The peer's own author stays editable: the guard narrows the relay
	// branch, it does not disable federation.
	if err := s.store.AddRawMessage(ctx, &model.Message{
		ID: "m2", ChatID: "c1", FromID: "bob:peer", FromNick: "bob",
		Text: "theirs", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteFederatedMessage(ctx, &live, "m2", 0); err != nil {
		t.Errorf("peer delete of its own author: unexpected error %v", err)
	}
}

// TestSendFederatedMessageRequiresAuthorMembership covers the second inbound
// hole: a peer may write only for its own users that are chat members.
func TestSendFederatedMessageRequiresAuthorMembership(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:localhost:8080", "b:peer"}, RemoteServer: "peer", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	// The author belongs to the peer, but is not in this conversation.
	_, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID: "m1", Peer: "peer", FromID: "intruder:peer", Text: "hello",
	}, MaxMessageLen)
	if !errors.Is(err, ErrFederatedFromNotRemote) {
		t.Errorf("expected ErrFederatedFromNotRemote for a non-member author, got %v", err)
	}

	// The owner relays a third server's member into its replica: still
	// allowed, because the author is a member and not local.
	group := &model.Chat{
		ID: "c2", Members: []string{"a:localhost:8080", "b:peer", "c:other"},
		RemoteServer: "peer", CreatedAt: time.Now().UTC(),
	}
	if err := s.store.CreateRemoteChat(ctx, group); err != nil {
		t.Fatal(err)
	}

	_, err = s.SendFederatedMessage(ctx, group, &FederatedInboundMessage{
		ID: "m2", Peer: "peer", FromID: "c:other", Text: "relayed",
	}, MaxMessageLen)
	if err != nil {
		t.Errorf("owner relay of a member author: unexpected error %v", err)
	}
}

func TestSyncFederated(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{ID: "c1", Members: []string{"a:loc", "b:rem"}, RemoteServer: "rem", CreatedAt: time.Now().UTC()}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: "b:rem", FromNick: "remote", Text: "hi", CreatedAt: now, UpdatedAt: now}
	if err := s.store.AddRawMessage(ctx, msg); err != nil {
		t.Fatal(err)
	}

	resp, err := s.SyncFederated(ctx, "rem", now.Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Messages) != 1 || resp.Messages[0].ID != "m1" {
		t.Errorf("expected one message m1, got %v", resp.Messages)
	}
	if len(resp.DeletedMessages) != 0 {
		t.Errorf("expected no deleted messages, got %v", resp.DeletedMessages)
	}
}

// TestCreateFederatedChatBroadcastsChatCreated guards the realtime fan-out:
// every local member must receive the chat_created SSE event when a remote
// server creates a chat (regression: the broadcast was lost in the A5 move).
func TestCreateFederatedChatBroadcastsChatCreated(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	members := []string{"a:loc", "b:rem"}
	channels := make([]chan sse.Event, 0, len(members))
	conns := make([]*sse.Connection, 0, len(members))

	for _, member := range members {
		connID := "conn-" + member
		conn := s.hub.Register(connID)

		if err := s.hub.AuthenticateSession(connID, member, "", time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}

		conns = append(conns, conn)
		channels = append(channels, conn.Channel)
	}

	defer func() {
		for i, conn := range conns {
			s.hub.Unregister("conn-"+members[i], conn)
		}
	}()

	view, already, err := s.CreateFederatedChat(ctx, "c-broadcast", members, "rem", "loc", "")
	if err != nil {
		t.Fatal(err)
	}

	if already {
		t.Fatal("expected first creation to be new")
	}

	for _, ch := range channels {
		select {
		case evt := <-ch:
			if evt.Event != "chat_created" {
				t.Fatalf("event = %q, want chat_created", evt.Event)
			}

			data, ok := evt.Data.(ChatView)
			if !ok || data.ID != view.ID {
				t.Fatalf("data = %v, want ChatView with id %q", evt.Data, view.ID)
			}
		case <-time.After(time.Second):
			t.Fatal("expected chat_created event on member channel")
		}
	}

	// Idempotent recreation must not broadcast again.
	if _, already, err := s.CreateFederatedChat(ctx, "c-broadcast", members, "rem", "loc", ""); err != nil || !already {
		t.Fatalf("expected idempotent recreation, err=%v already=%v", err, already)
	}

	select {
	case evt := <-channels[0]:
		t.Fatalf("unexpected event after idempotent call: %v", evt)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestSyncIncludesFederatedMessage is the end-to-end regression for inbound
// peer messages never reaching a catch-up sync: such rows were stored with a
// frozen updated_at and failed the delta's `updated_at >= since` filter, so a
// client that was offline at the time only ever saw them live over SSE.
func TestSyncIncludesFederatedMessage(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "a@t.local", "a", "loc", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat := &model.Chat{
		ID:           "c1",
		Members:      []string{"a:loc", "b:rem"},
		RemoteServer: "rem",
		CreatedAt:    time.Now().UTC(),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID:       "m1",
		FromID:   "b:rem",
		FromNick: "remote",
		Text:     "hello",
	}, MaxMessageLen); err != nil {
		t.Fatal(err)
	}

	resp, err := s.Sync(ctx, "a:loc", time.Now().UTC().Add(-time.Hour), "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Messages) != 1 || resp.Messages[0].ID != "m1" {
		t.Fatalf("sync delta omitted the federated message, got %d messages", len(resp.Messages))
	}
}

func TestCreateFederatedGroupReplica(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	view, already, err := s.CreateFederatedGroup(
		ctx, "group-1", "Trip", "owner:remote.test",
		[]string{"owner:remote.test", "alice:localhost:8080"},
		"remote.test", "localhost:8080",
	)
	if err != nil {
		t.Fatal(err)
	}
	if already || view.ID != "group-1" {
		t.Fatalf("view = %+v already=%v", view, already)
	}
	chat, ok := s.store.GetChat(ctx, "group-1")
	if !ok || chat.Type != "group" || chat.RemoteServer != "remote.test" {
		t.Fatalf("chat = %+v", chat)
	}

	if _, already, err := s.CreateFederatedGroup(
		ctx, "group-1", "Trip", "owner:remote.test",
		[]string{"owner:remote.test", "alice:localhost:8080"},
		"remote.test", "localhost:8080",
	); err != nil || !already {
		t.Fatalf("second create: already=%v err=%v", already, err)
	}
}

// A peer may not force a membership of a local account that does not exist:
// the ghost would keep a phantom row in every member list forever.
func TestCreateFederatedGroupRejectsGhostLocalMember(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	_, _, err := s.CreateFederatedGroup(
		ctx, "group-1", "Trip", "owner:remote.test",
		[]string{"owner:remote.test", "ghost:localhost:8080"},
		"remote.test", "localhost:8080",
	)
	if !errors.Is(err, ErrFederatedMembersNotValid) {
		t.Fatalf("error = %v, want ErrFederatedMembersNotValid", err)
	}

	if _, ok := s.store.GetChat(ctx, "group-1"); ok {
		t.Fatal("the chat was created with a ghost member")
	}
}

func TestCreateFederatedGroupRejectsOverlongName(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	_, _, err := s.CreateFederatedGroup(
		ctx, "group-1", strings.Repeat("x", groupNameMaxLen+1), "owner:remote.test",
		[]string{"owner:remote.test", "alice:localhost:8080"},
		"remote.test", "localhost:8080",
	)
	if !errors.Is(err, ErrGroupNameInvalid) {
		t.Fatalf("error = %v, want ErrGroupNameInvalid", err)
	}
}

func TestCreateGroupChatReplicatesToOwner(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fed := &fakeFederationClient{}
	s.SetFederationClient(fed)

	view, err := s.CreateGroupChat(ctx, owner.ID, "Remote group", []string{"bob:remote.test"})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Members) != 2 {
		t.Fatalf("members = %v", view.Members)
	}
	if len(fed.requests) != 1 || fed.requests[0] != "https://remote.test/api/federated/groups" {
		t.Fatalf("federation requests = %v", fed.requests)
	}
	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok || chat.Type != "group" || chat.RemoteServer != "" {
		t.Fatalf("owner chat = %+v", chat)
	}
}

func TestForwardFederatedGroupMessageSkipsSenderReplica(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fed := &fakeFederationClient{}
	s.SetFederationClient(fed)

	view, err := s.CreateGroupChat(ctx, owner.ID, "Remote group", []string{
		"bob:remote.test",
		"carol:other.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	fed.requests = nil

	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("group missing")
	}
	s.forwardFederatedGroupMessage(ctx, chat, &FederatedInboundMessage{
		ID:       "m1",
		FromID:   "bob:remote.test",
		FromNick: "bob",
		Text:     "hello",
	})

	if len(fed.requests) != 1 || fed.requests[0] != "https://other.test/api/federated/chats/"+view.ID+"/messages" {
		t.Fatalf("forward requests = %v", fed.requests)
	}
}

func TestSendFederatedMessageStoresRemoteAttachment(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	view, _, err := s.CreateFederatedChat(ctx, "fed-file-chat",
		[]string{"alice:localhost:8080", "bob:remote.test"}, "remote.test", "localhost:8080", "")
	if err != nil {
		t.Fatal(err)
	}
	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("chat missing")
	}

	msg, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID:       "m-file",
		FromID:   "bob:remote.test",
		FromNick: "bob",
		Text:     "",
		Files: []model.FileInfo{{
			ID:           "f1",
			Hash:         "hash",
			MimeType:     "image/png",
			Size:         42,
			OriginalName: "photo.png",
		}},
	}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg.Files) != 1 || msg.Files[0].ID != "f1" {
		t.Fatalf("message files = %+v", msg.Files)
	}
	file, err := s.store.GetFile(ctx, "f1")
	if err != nil || file.RemoteServer != "remote.test" || file.StoragePath != "" {
		t.Fatalf("file = %+v err=%v", file, err)
	}
}

func TestFederatedGroupMembershipFanout(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fed := &fakeFederationClient{}
	s.SetFederationClient(fed)

	view, err := s.CreateGroupChat(ctx, owner.ID, "Group", []string{"bob:remote.test"})
	if err != nil {
		t.Fatal(err)
	}
	fed.requests = nil

	if _, err := s.AddChatMember(ctx, view.ID, "carol:other.test"); err != nil {
		t.Fatal(err)
	}
	if len(fed.requests) < 2 {
		t.Fatalf("add member requests = %v", fed.requests)
	}

	fed.requests = nil
	if _, err := s.RemoveChatMember(ctx, view.ID, "carol:other.test", owner.ID); err != nil {
		t.Fatal(err)
	}
	if len(fed.requests) < 2 {
		t.Fatalf("remove member requests = %v", fed.requests)
	}
}

func TestFederatedGroupRenameAndDeleteFanout(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()
	owner, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	fed := &fakeFederationClient{}
	s.SetFederationClient(fed)

	view, err := s.CreateGroupChat(ctx, owner.ID, "Group", []string{"bob:remote.test"})
	if err != nil {
		t.Fatal(err)
	}
	fed.requests = nil
	if _, err := s.UpdateChatName(ctx, view.ID, "Renamed"); err != nil {
		t.Fatal(err)
	}
	if len(fed.requests) != 1 || fed.requests[0] != "https://remote.test/api/federated/groups/"+view.ID {
		t.Fatalf("rename requests = %v", fed.requests)
	}

	fed.requests = nil
	chat, ok := s.store.GetChat(ctx, view.ID)
	if !ok {
		t.Fatal("chat missing")
	}
	if err := s.DeleteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}
	if len(fed.requests) != 1 || fed.requests[0] != "https://remote.test/api/federated/groups/"+view.ID {
		t.Fatalf("delete requests = %v", fed.requests)
	}
}

// A peer may not attach an existing local file of somebody outside the chat to
// its own message: that would hand the file's bytes to the members.
func TestSendFederatedMessageRejectsAFileOfANonMember(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{
		ID: "c1", Members: []string{"a:localhost:8080", "b:remote.test"},
		RemoteServer: "remote.test", CreatedAt: time.Now().UTC(),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	// The file already exists on this server and belongs to a stranger.
	if err := s.store.CreateRemoteFile(ctx, &model.File{
		ID: "f-stranger", Hash: "h1", MimeType: "text/plain", Size: 4,
		OriginalName: "secret.txt", UploadedBy: "stranger:localhost:8080",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID: "m1", FromID: "b:remote.test", Text: "look",
		Files: []model.FileInfo{{ID: "f-stranger", MimeType: "text/plain"}},
	}, MaxMessageLen); err != nil {
		t.Fatal(err)
	}

	files, err := s.store.GetMessageFiles(ctx, "m1")
	if err != nil {
		t.Fatal(err)
	}

	if len(files) != 0 {
		t.Fatalf("attached %d files, want none: %+v", len(files), files)
	}
}

// A file uploaded by a chat member may still be reused by the peer.
func TestSendFederatedMessageReusesAFileOfAMember(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	chat := &model.Chat{
		ID: "c1", Members: []string{"a:localhost:8080", "b:remote.test"},
		RemoteServer: "remote.test", CreatedAt: time.Now().UTC(),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	if err := s.store.CreateRemoteFile(ctx, &model.File{
		ID: "f-member", Hash: "h2", MimeType: "text/plain", Size: 4,
		OriginalName: "shared.txt", UploadedBy: "b:remote.test",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := s.SendFederatedMessage(ctx, chat, &FederatedInboundMessage{
		ID: "m1", FromID: "b:remote.test", Text: "look",
		Files: []model.FileInfo{{ID: "f-member", MimeType: "text/plain"}},
	}, MaxMessageLen); err != nil {
		t.Fatal(err)
	}

	files, err := s.store.GetMessageFiles(ctx, "m1")
	if err != nil {
		t.Fatal(err)
	}

	if len(files) != 1 || files[0].ID != "f-member" {
		t.Fatalf("files = %+v, want the member file", files)
	}
}
