package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeleteMessageHandler(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "hello", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodDelete, "/api/chats/"+chat.ID+"/messages/m1", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteMessage)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Message should be gone.
	if _, err := h.store.GetMessage(context.Background(), chat.ID, "m1"); err == nil {
		t.Error("expected message to be deleted")
	}
}

func TestDeleteMessageForbiddenForOtherAuthor(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id, bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "hello", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	// Bob tries to delete Alice's message.
	req := authReq(http.MethodDelete, "/api/chats/"+chat.ID+"/messages/m1", bob.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteMessage)(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeleteMessageNotFound(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodDelete, "/api/chats/"+chat.ID+"/messages/ghost", alice.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "ghost")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteMessage)(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeleteMessageRejectsNonMember(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	evil := registerTestUser(t, h, "evil", "evil@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.AddMessage(context.Background(), chat.ID, "", alice.id, "alice", "hello", "m1", "", nil, false, ""); err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodDelete, "/api/chats/"+chat.ID+"/messages/m1", evil.token, "")
	req.SetPathValue("id", chat.ID)
	req.SetPathValue("messageId", "m1")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteMessage)(w, req)

	if w.Code != http.StatusForbidden && w.Code != http.StatusNotFound {
		t.Fatalf("non-member should be rejected, got %d", w.Code)
	}
}
