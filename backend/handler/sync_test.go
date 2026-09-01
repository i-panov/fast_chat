package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"fast_chat/service"
)

func doSync(t *testing.T, h *Handler, token, since string) (service.SyncResponse, int) {
	t.Helper()

	req := authReq(http.MethodGet, "/api/sync?since="+since, token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.Sync)(w, req)

	var resp service.SyncResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal sync: %v (body: %s)", err, w.Body.String())
		}
	}

	return resp, w.Code
}

func TestSyncEndToEnd(t *testing.T) {
	h := newTestHandler(t)

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	// Create a group chat with both members.
	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatalf("create group chat: %v", err)
	}

	// Send a couple of messages.
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "hello", "m1", "", nil, false, ""); err != nil {
		t.Fatalf("add m1: %v", err)
	}

	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", bob.id, "bob", "world", "m2", "", nil, false, ""); err != nil {
		t.Fatalf("add m2: %v", err)
	}

	// Delete m1 -> tombstone.
	if err := h.store.DeleteMessage(context.Background(), chat.ID, "m1", alice.id); err != nil {
		t.Fatalf("delete m1: %v", err)
	}

	resp, code := doSync(t, h, alice.token, "1970-01-01T00:00:00Z")
	if code != http.StatusOK {
		t.Fatalf("sync status = %d: body %s", code, "")
	}

	if len(resp.Chats) < 1 {
		t.Fatalf("expected at least 1 changed chat, got %d", len(resp.Chats))
	}

	var found service.SyncChatDTO
	for _, c := range resp.Chats {
		if c.Name == "room" {
			found = c
		}
	}

	if found.ID == "" {
		t.Fatalf("expected the group chat 'room' in changed chats, got %+v", resp.Chats)
	}

	if len(found.Members) < 1 {
		t.Errorf("expected members in chat dto")
	}

	// Members must resolve to nicks (alice, bob).
	nickByID := map[string]string{}
	for _, m := range found.Members {
		nickByID[m.ID] = m.Nick
	}

	if nickByID[alice.id] != "alice" || nickByID[bob.id] != "bob" {
		t.Errorf("member nicks not resolved: %v", nickByID)
	}

	// m2 remains, m1 is tombstoned.
	texts := map[string]bool{}
	for _, m := range resp.Messages {
		texts[m.ID] = true
	}

	if !texts["m2"] {
		t.Errorf("expected m2 in messages, got %v", texts)
	}

	if texts["m1"] {
		t.Errorf("m1 should be deleted, not present: %v", texts)
	}

	if len(resp.DeletedMessages) != 1 || resp.DeletedMessages[0].MessageID != "m1" {
		t.Errorf("expected deleted message m1, got %+v", resp.DeletedMessages)
	}
}

func TestSyncInvalidSince(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	req := authReq(http.MethodGet, "/api/sync?since=garbage", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.Sync)(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid since, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSyncDeletedChatTombstone(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatalf("create group chat: %v", err)
	}

	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "hi", "m1", "", nil, false, ""); err != nil {
		t.Fatalf("add m1: %v", err)
	}

	// Deleting a group chat writes DeletedChat tombstones for every member.
	if err := h.store.DeleteChat(context.Background(), chat.ID); err != nil {
		t.Fatalf("delete chat: %v", err)
	}

	resp, code := doSync(t, h, alice.token, "1970-01-01T00:00:00Z")
	if code != http.StatusOK {
		t.Fatalf("sync status = %d", code)
	}

	if len(resp.DeletedChats) != 1 || resp.DeletedChats[0].ChatID != chat.ID {
		t.Errorf("expected deleted chat tombstone for %s, got %+v", chat.ID, resp.DeletedChats)
	}
	// The chat is no longer among the user's chats, so message
	// tombstones are not enumerated via chatIDs here; the client learns
	// the chat is gone through the DeletedChats tombstone instead.
}

func TestSyncSinceFilter(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatalf("create chat: %v", err)
	}

	// Message created "now".
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "recent", "m1", "", nil, false, ""); err != nil {
		t.Fatalf("add m1: %v", err)
	}

	// A since far in the future filters everything out.
	future := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	resp, code := doSync(t, h, alice.token, url.QueryEscape(future))
	if code != http.StatusOK {
		t.Fatalf("sync status = %d", code)
	}

	if len(resp.Messages) != 0 {
		t.Errorf("expected no messages with future since, got %+v", resp.Messages)
	}

	if len(resp.Chats) != 0 {
		t.Errorf("expected no chats with future since, got %+v", resp.Chats)
	}
}
