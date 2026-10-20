package service

import (
	"context"
	"encoding/json"
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
// delta it took from it.
func TestCatchupUsesTheCursor(t *testing.T) {
	s := newFedTestService(t)
	ctx := context.Background()

	client := &fakeFederationClient{response: SyncFederatedResponse{ServerNow: time.Now().UTC()}}
	s.SetFederationClient(client)

	s.catchupPeer(ctx, "remote.test")

	if len(client.requests) != 1 {
		t.Fatalf("made %d requests, want 1", len(client.requests))
	}

	if client.requests[0] == "" {
		t.Fatal("the catch-up did not ask for a delta")
	}
}
