package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fast_chat/model"
)

func testRemoteChat(t *testing.T, h *Handler, chatID string) {
	t.Helper()
	chat := &model.Chat{
		ID:           chatID,
		Type:         "private",
		Members:      []string{"local:localhost:8080", "remote:remote.test"},
		RemoteServer: "remote.test",
		CreatedAt:    time.Now(),
	}
	if err := h.store.CreateRemoteChat(context.Background(), chat); err != nil {
		t.Fatal(err)
	}
}

func TestFederatedSendMessageHappy(t *testing.T) {
	h := newTestHandler(t)
	testRemoteChat(t, h, "fed-send-ok")

	body := `{"id":"fm1","fromId":"remote:remote.test","fromNick":"remote","text":"hello"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost, "/api/federated/chats/fed-send-ok/messages",
		strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "fed-send-ok")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedSendMessage(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	msg, err := h.store.GetMessage(context.Background(), "fed-send-ok", "fm1")
	if err != nil {
		t.Fatalf("message should be stored: %v", err)
	}
	if msg.FromNick != "remote" || msg.Text != "hello" {
		t.Errorf("unexpected stored message: %+v", msg)
	}
}

func TestFederatedSendMessageRequiresID(t *testing.T) {
	h := newTestHandler(t)
	testRemoteChat(t, h, "fed-send-id")

	body := `{"fromId":"remote:remote.test","fromNick":"remote","text":"hello"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost, "/api/federated/chats/fed-send-id/messages",
		strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "fed-send-id")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedSendMessage(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing id: expected 400, got %d", w.Code)
	}
}

func TestFederatedEditMessageHappy(t *testing.T) {
	h := newTestHandler(t)
	testRemoteChat(t, h, "fed-edit-ok")

	// Seed an original remote message.
	msg := &model.Message{
		ID:        "fm1",
		ChatID:    "fed-edit-ok",
		FromID:    "remote:remote.test",
		FromNick:  "remote",
		Text:      "original",
		CreatedAt: time.Now(),
	}
	if err := h.store.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatal(err)
	}

	body := `{"text":"edited"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPatch,
		"/api/federated/chats/fed-edit-ok/messages/fm1", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "fed-edit-ok")
	req.SetPathValue("messageId", "fm1")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedEditMessage(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	got, err := h.store.GetMessage(context.Background(), "fed-edit-ok", "fm1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "edited" {
		t.Errorf("expected edited text, got %q", got.Text)
	}
}

func TestGetValidFileIDs(t *testing.T) {
	h := newTestHandler(t)

	f1, err := h.store.SaveFile(context.Background(), "h1", "text/plain", 10, "a.txt", "/tmp/a.txt")
	if err != nil {
		t.Fatal(err)
	}
	f2, err := h.store.SaveFile(context.Background(), "h2", "text/plain", 20, "b.txt", "/tmp/b.txt")
	if err != nil {
		t.Fatal(err)
	}

	valid := h.svc.ValidFileIDs(context.Background(), []string{f1.ID, "nope", f2.ID})
	if len(valid) != 2 {
		t.Fatalf("expected 2 valid IDs, got %v", valid)
	}
	if valid[0] != f1.ID || valid[1] != f2.ID {
		t.Errorf("unexpected valid IDs: %v", valid)
	}

	// All-invalid returns empty.
	empty := h.svc.ValidFileIDs(context.Background(), []string{"zz", "yy"})
	if len(empty) != 0 {
		t.Errorf("expected empty, got %v", empty)
	}
}
