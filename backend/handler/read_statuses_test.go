package handler

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMarkMessagesReadHandler(t *testing.T) {
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

	body := `{"messageIds":["m1"],"chatId":"` + chat.ID + `"}`
	req := authReq(http.MethodPost, "/api/messages/read", bob.token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.MarkMessagesRead)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the status was actually stored.
	statuses, err := h.store.GetMessageReadStatusesBatch(context.Background(), []string{"m1"}, bob.id)
	if err != nil {
		t.Fatal(err)
	}
	if statuses["m1"] != "read" {
		t.Errorf("expected read status, got %q", statuses["m1"])
	}
}

func TestMarkMessagesReadValidation(t *testing.T) {
	h := newTestHandler(t)
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	// Empty message list.
	req := authReq(http.MethodPost, "/api/messages/read", bob.token, `{"messageIds":[],"chatId":"c1"}`)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.MarkMessagesRead)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty ids: expected 400, got %d", w.Code)
	}

	// Too many message IDs.
	var b strings.Builder
	b.WriteString(`{"messageIds":[`)
	for i := range 101 {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"x"`)
	}
	b.WriteString(`],"chatId":"c1"}`)
	req = authReq(http.MethodPost, "/api/messages/read", bob.token, b.String())
	w = httptest.NewRecorder()
	h.AuthMiddleware(h.MarkMessagesRead)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("too many ids: expected 400, got %d", w.Code)
	}
}

func TestMarkMessagesReadInvalidJSON(t *testing.T) {
	h := newTestHandler(t)
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	req := authReq(http.MethodPost, "/api/messages/read", bob.token, `{"messageIds":`)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.MarkMessagesRead)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid json: expected 400, got %d", w.Code)
	}
}

func TestMarkMessagesReadRejectsNonMember(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	evil := registerTestUser(t, h, "evil", "evil@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", alice.id, []string{alice.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	body := `{"messageIds":["m1"],"chatId":"` + chat.ID + `"}`
	req := authReq(http.MethodPost, "/api/messages/read", evil.token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.MarkMessagesRead)(w, req)
	if w.Code != http.StatusForbidden && w.Code != http.StatusNotFound {
		t.Fatalf("non-member should be rejected, got %d", w.Code)
	}
}

func TestGetMessagesWithStatusesHandler(t *testing.T) {
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

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/query", bob.token, `{"limit":50}`)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.GetMessagesWithStatuses)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("m1")) {
		t.Errorf("response should contain message m1, got: %s", w.Body.String())
	}
}

func TestGetMessagesWithStatusesInvalidBody(t *testing.T) {
	h := newTestHandler(t)
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat, err := h.store.CreateGroupChat(context.Background(), "room", bob.id, []string{bob.id}, "")
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages/query", bob.token, `{bad`)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.GetMessagesWithStatuses)(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid body: expected 400, got %d", w.Code)
	}
}
