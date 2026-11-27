package service

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"
	"time"

	"fast_chat/model"
)

// fakeFederationClient serves a canned catch-up response.
type fakeFederationClient struct {
	response SyncFederatedResponse
	requests []string
}

func (f *fakeFederationClient) URL(remoteServer, path string) string {
	return "https://" + remoteServer + path
}

func (f *fakeFederationClient) Request(_ context.Context, _, urlStr string, _ any) ([]byte, error) {
	f.requests = append(f.requests, urlStr)

	return json.Marshal(f.response)
}

// The catch-up applies what the peer reports: the chat is created locally and
// the messages of the peer land in it.
func TestCatchupAppliesThePeerDelta(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	created := time.Now().UTC().Add(-time.Minute)

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: created.Add(time.Second),
			Chats: []FederatedChatDTO{{
				ID:        "chat-1",
				Type:      "private",
				Members:   []string{"alice:localhost:8080", "bob:remote.test"},
				CreatedAt: created,
			}},
			Messages: []model.Message{{
				ID:        "msg-1",
				ChatID:    "chat-1",
				FromID:    "bob:remote.test",
				FromNick:  "bob",
				Text:      "hello",
				CreatedAt: created,
			}},
		},
	}

	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	chat, ok := s.store.GetChat(ctx, "chat-1")
	if !ok {
		t.Fatal("the chat of the peer was not created")
	}

	if chat.RemoteServer != "remote.test" {
		t.Errorf("remote server = %q, want %q", chat.RemoteServer, "remote.test")
	}

	if len(chat.Members) != 2 {
		t.Errorf("members = %v, want two", chat.Members)
	}

	msg, err := s.store.GetMessage(ctx, "chat-1", "msg-1")
	if err != nil {
		t.Fatalf("the message of the peer was not stored: %v", err)
	}

	if msg.Text != "hello" {
		t.Errorf("message text = %q, want %q", msg.Text, "hello")
	}

	// The cursor moved to the moment the peer reported.
	if cursor := s.store.GetFederationCursor(ctx, "remote.test"); !cursor.After(created) {
		t.Errorf("cursor = %v, want a moment after %v", cursor, created)
	}
}

// The catch-up is idempotent: the same delta twice leaves one message.
func TestCatchupIsIdempotent(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	created := time.Now().UTC().Add(-time.Minute)

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: created.Add(time.Second),
			Chats: []FederatedChatDTO{{
				ID:        "chat-1",
				Type:      "private",
				Members:   []string{"alice:localhost:8080", "bob:remote.test"},
				CreatedAt: created,
			}},
			Messages: []model.Message{{
				ID:        "msg-1",
				ChatID:    "chat-1",
				FromID:    "bob:remote.test",
				FromNick:  "bob",
				Text:      "hello",
				CreatedAt: created,
			}},
		},
	}

	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")
	s.catchupPeer(ctx, "remote.test")

	var count int64
	if err := s.store.DB().Model(&model.Message{}).Where("id = ?", "msg-1").Count(&count).Error; err != nil {
		t.Fatal(err)
	}

	if count != 1 {
		t.Fatalf("stored %d copies of the message, want 1", count)
	}
}

// The peer is authoritative for the chat: a member that joined while this
// server was offline has to show up in the local membership.
func TestCatchupUpdatesTheChatMembers(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice.ID, "bob:remote.test", "remote.test")
	if err != nil {
		t.Fatal(err)
	}

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: time.Now().UTC(),
			Chats: []FederatedChatDTO{{
				ID:        chat.ID,
				Type:      "private",
				Members:   []string{alice.ID, "bob:remote.test", "carol:remote.test"},
				CreatedAt: chat.CreatedAt,
			}},
		},
	}

	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	updated, ok := s.store.GetChat(ctx, chat.ID)
	if !ok {
		t.Fatal("the chat is gone")
	}

	if len(updated.Members) != 3 {
		t.Fatalf("members = %v, want three", updated.Members)
	}

	found := false
	for _, memberID := range updated.Members {
		if memberID == "carol:remote.test" {
			found = true
		}
	}

	if !found {
		t.Fatalf("the new member is missing: %v", updated.Members)
	}
}

// A peer that reports a chat without members would empty it locally. The
// report is broken in that case, so the membership stays untouched.
func TestCatchupKeepsTheMembersOfAnEmptyReport(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	alice, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	chat, err := s.store.CreateChat(ctx, alice.ID, "bob:remote.test", "remote.test")
	if err != nil {
		t.Fatal(err)
	}

	client := &fakeFederationClient{
		response: SyncFederatedResponse{
			ServerNow: time.Now().UTC(),
			Chats: []FederatedChatDTO{{
				ID:        chat.ID,
				Type:      "private",
				Members:   []string{},
				CreatedAt: chat.CreatedAt,
			}},
		},
	}

	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	updated, ok := s.store.GetChat(ctx, chat.ID)
	if !ok {
		t.Fatal("the chat is gone")
	}

	if len(updated.Members) != 2 {
		t.Fatalf("members = %v, want the two members", updated.Members)
	}
}

// The catch-up asks the peer for everything that changed since the last
// delta it took from it, and parks the cursor at what the peer reported.
func TestCatchupUsesTheCursor(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	since := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	if err := s.store.SetFederationCursor(ctx, "remote.test", since); err != nil {
		t.Fatal(err)
	}

	serverNow := time.Now().UTC().Truncate(time.Second)
	client := &fakeFederationClient{response: SyncFederatedResponse{ServerNow: serverNow}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	if len(client.requests) != 1 {
		t.Fatalf("made %d requests, want 1", len(client.requests))
	}

	parsed, err := url.Parse(client.requests[0])
	if err != nil {
		t.Fatal(err)
	}

	if got := parsed.Query().Get("since"); got != since.Format(time.RFC3339) {
		t.Errorf("since = %q, want %q", got, since.Format(time.RFC3339))
	}

	if cursor := s.store.GetFederationCursor(ctx, "remote.test"); !cursor.Equal(serverNow) {
		t.Errorf("cursor = %v, want %v", cursor, serverNow)
	}
}

// An unparsable NextSince is not a reason to skip the rest of the backlog:
// the cursor must stay where the last applied page ended.
func TestCatchupKeepsTheCursorOnAnUnparsableNextSince(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	since := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	if err := s.store.SetFederationCursor(ctx, "remote.test", since); err != nil {
		t.Fatal(err)
	}

	client := &fakeFederationClient{response: SyncFederatedResponse{
		ServerNow:   time.Now().UTC(),
		NextSince:   "not-a-timestamp",
		NextSinceID: "row-1",
	}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	if cursor := s.store.GetFederationCursor(ctx, "remote.test"); !cursor.Equal(since) {
		t.Errorf("cursor = %v, want the unchanged %v", cursor, since)
	}
}

// The participant→owner direction of a locally owned group is covered by the
// catch-up as well: after the outbox gives up, the participant's copy is the
// only one left.
func TestCatchupAppliesParticipantMessageToOwnedGroup(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat := &model.Chat{
		ID:        "group-1",
		Type:      "group",
		OwnerID:   "alice:localhost:8080",
		Members:   []string{"alice:localhost:8080", "bob:remote.test"},
		CreatedAt: time.Now().UTC().Add(-time.Minute),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	created := time.Now().UTC().Add(-time.Minute)
	client := &fakeFederationClient{response: SyncFederatedResponse{
		ServerNow: time.Now().UTC(),
		Messages: []model.Message{{
			ID:        "msg-1",
			ChatID:    "group-1",
			FromID:    "bob:remote.test",
			FromNick:  "bob",
			Text:      "hello from the participant",
			CreatedAt: created,
		}},
	}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	if _, err := s.store.GetMessage(ctx, "group-1", "msg-1"); err != nil {
		t.Fatalf("the participant message was not applied to the owned group: %v", err)
	}
}

// The same delta must not let the peer write for a user of another server in
// a chat this server owns.
func TestCatchupRejectsForeignAuthorInOwnedGroup(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	if _, err := s.store.CreateUser(ctx, "alice@test.local", "alice", "localhost:8080", time.Hour); err != nil {
		t.Fatal(err)
	}

	chat := &model.Chat{
		ID:        "group-1",
		Type:      "group",
		OwnerID:   "alice:localhost:8080",
		Members:   []string{"alice:localhost:8080", "bob:remote.test", "carol:evil.test"},
		CreatedAt: time.Now().UTC().Add(-time.Minute),
	}
	if err := s.store.CreateRemoteChat(ctx, chat); err != nil {
		t.Fatal(err)
	}

	created := time.Now().UTC().Add(-time.Minute)
	client := &fakeFederationClient{response: SyncFederatedResponse{
		ServerNow: time.Now().UTC(),
		Messages: []model.Message{{
			ID:        "msg-1",
			ChatID:    "group-1",
			FromID:    "carol:evil.test",
			FromNick:  "carol",
			Text:      "forged",
			CreatedAt: created,
		}},
	}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	if _, err := s.store.GetMessage(ctx, "group-1", "msg-1"); err == nil {
		t.Fatal("the peer wrote a message for a user of another server")
	}
}

// A delta row whose thread id collides with a thread of another chat fails
// forever; it must be skipped instead of pinning the peer's cursor.
func TestCatchupSkipsAPoisonedThreadRow(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	// The thread exists, but belongs to another chat: the row can never be
	// applied, no matter how often it is retried.
	if _, err := s.store.UpsertRemoteThread(ctx, &model.Thread{
		ID: "foreign-thread", ChatID: "another-chat", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	created := time.Now().UTC().Add(-time.Minute)
	client := &fakeFederationClient{response: SyncFederatedResponse{
		ServerNow: time.Now().UTC(),
		Chats: []FederatedChatDTO{{
			ID:        "chat-1",
			Type:      "private",
			Members:   []string{"alice:localhost:8080", "bob:remote.test"},
			CreatedAt: created,
		}},
		Messages: []model.Message{{
			ID:        "msg-1",
			ChatID:    "chat-1",
			ThreadID:  "foreign-thread",
			FromID:    "bob:remote.test",
			FromNick:  "bob",
			Text:      "poisoned",
			CreatedAt: created,
		}},
	}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	// The row is skipped as permanent, so the cursor still advances and the
	// chat of the peer keeps flowing.
	if cursor := s.store.GetFederationCursor(ctx, "remote.test"); !cursor.After(created) {
		t.Errorf("cursor = %v, want it past %v (the poisoned row pinned it)", cursor, created)
	}

	if _, err := s.store.GetMessage(ctx, "chat-1", "msg-1"); err == nil {
		t.Fatal("the poisoned row was applied")
	}
}
