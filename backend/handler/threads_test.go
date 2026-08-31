package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateThreadAndList(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "parent", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	// Create thread on m1.
	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/m1/thread", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateThread)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Thread struct {
			ID              string `json:"id"`
			ParentMessageID string `json:"parentMessageId"`
			ChatID          string `json:"chatId"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	threadID := resp.Thread.ID
	if threadID == "" || resp.Thread.ChatID != chat.ID {
		t.Fatalf("unexpected thread payload: %s", w.Body.String())
	}

	// GetThreads lists it.
	req2 := authReq(http.MethodGet, "/api/chats/"+chat.ID+"/threads", alice.token, "")
	req2.SetPathValue("id", chat.ID)
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(h.GetThreads)(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("GetThreads: expected 200, got %d", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), threadID) {
		t.Errorf("GetThreads should contain thread %s, got %s", threadID, w2.Body.String())
	}
}

func TestCreateThreadDuplicateIsConflict(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "parent", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/m1/thread", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateThread)(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("first create: expected 201, got %d", w.Code)
	}

	// Second create on same parent -> conflict.
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateThread)(w2, req)
	if w2.Code != http.StatusConflict {
		t.Fatalf("duplicate thread: expected 409, got %d", w2.Code)
	}
}

func TestCreateThreadMessageNotFound(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/ghost/thread", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "ghost")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateThread)(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetThreadMessages(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "parent", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/m1/thread", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateThread)(w, req)

	var resp struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	threadID := resp.Thread.ID

	// Add a message to the thread via store.
	if _, err := h.store.AddMessage(context.Background(), chat.ID, threadID, bob.id, "bob", "reply", "r1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	req2 := authReq(http.MethodGet, "/api/chats/"+chat.ID+"/threads/"+threadID+"/messages", bob.token, "")
	req2.SetPathValue("id", chat.ID)
	req2.SetPathValue("threadId", threadID)
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(h.GetThreadMessages)(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w2.Code, w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), "r1") {
		t.Errorf("expected reply r1 in response, got %s", w2.Body.String())
	}
}

func TestGetThreadMessagesNotFound(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodGet, "/api/chats/"+chat.ID+"/threads/none/messages", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("threadId", "none")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.GetThreadMessages)(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}
