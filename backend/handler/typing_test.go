package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleTypingFlow(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	// Active typing -> ok, not throttled (first in window).
	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/typing", alice.token, `{"active":true}`)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.HandleTyping)(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("active typing: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "throttled") {
		t.Fatalf("first active should not be throttled, got %s", w.Body.String())
	}

	// Immediate second active -> throttled.
	req2 := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/typing", alice.token, `{"active":true}`)
	req2.SetPathValue("id", chat.ID)
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(h.HandleTyping)(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("throttled typing: expected 200, got %d", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "throttled") {
		t.Fatalf("expected throttled status, got %s", w2.Body.String())
	}

	// Stop typing is never throttled.
	req3 := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/typing", alice.token, `{"active":false}`)
	req3.SetPathValue("id", chat.ID)
	w3 := httptest.NewRecorder()
	h.AuthMiddleware(h.HandleTyping)(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("stop typing: expected 200, got %d", w3.Code)
	}
	if strings.Contains(w3.Body.String(), "throttled") {
		t.Fatalf("stop should never be throttled, got %s", w3.Body.String())
	}
}

func TestHandleTypingInvalidBody(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/typing", alice.token, `{bad`)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.HandleTyping)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestHandleTypingRejectsNonMember(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	evil := registerTestUser(t, h, "evil", "evil@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/typing", evil.token, `{"active":true}`)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.HandleTyping)(w, req)
	if w.Code != http.StatusForbidden && w.Code != http.StatusNotFound {
		t.Fatalf("non-member should be rejected, got %d", w.Code)
	}
}
