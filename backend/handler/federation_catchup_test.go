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

func setupRemoteChat(t *testing.T, h *Handler, chatID string) {
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

	msg := &model.Message{
		ID:        "fm1",
		ChatID:    chatID,
		FromID:    "remote:remote.test",
		FromNick:  "remote",
		Text:      "hello from remote",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := h.store.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
}

func TestFederatedSync(t *testing.T) {
	h := newTestHandler(t)
	setupRemoteChat(t, h, "remote-chat-sync")

	sinc := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodGet,
		"/api/federated/sync?since="+sinc, nil,
	)
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedSync(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"fm1"`) {
		t.Errorf("expected remote message fm1 in sync response, got %s", w.Body.String())
	}
}

func TestFederatedSyncInvalidSince(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodGet,
		"/api/federated/sync?since=not-a-time", nil,
	)
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedSync(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestFederatedSyncMissingServer(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodGet,
		"/api/federated/sync?since=2020-01-01T00:00:00Z", nil,
	)

	w := httptest.NewRecorder()
	h.FederatedSync(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestFederatedDeleteMessage(t *testing.T) {
	h := newTestHandler(t)
	setupRemoteChat(t, h, "remote-chat-del")

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodDelete,
		"/api/federated/chats/remote-chat-del/messages/fm1", nil,
	)
	req.SetPathValue("id", "remote-chat-del")
	req.SetPathValue("messageId", "fm1")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedDeleteMessage(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if _, err := h.store.GetMessage(context.Background(), "remote-chat-del", "fm1"); err == nil {
		t.Error("expected message to be deleted")
	}
}

func TestFederatedDeleteMessageWrongServer(t *testing.T) {
	h := newTestHandler(t)
	setupRemoteChat(t, h, "remote-chat-del2")

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodDelete,
		"/api/federated/chats/remote-chat-del2/messages/fm1", nil,
	)
	req.SetPathValue("id", "remote-chat-del2")
	req.SetPathValue("messageId", "fm1")
	req.Header.Set("X-Federation-Server", "evil.test")

	w := httptest.NewRecorder()
	h.FederatedDeleteMessage(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("wrong server: expected 403, got %d", w.Code)
	}
}

func TestFederatedDeleteMessageAuthorNotRemote(t *testing.T) {
	h := newTestHandler(t)

	chat := &model.Chat{
		ID:           "remote-chat-del3",
		Type:         "private",
		Members:      []string{"local:localhost:8080", "remote:remote.test"},
		RemoteServer: "remote.test",
		CreatedAt:    time.Now(),
	}
	if err := h.store.CreateRemoteChat(context.Background(), chat); err != nil {
		t.Fatal(err)
	}

	// Local author -> remote server cannot delete it.
	msg := &model.Message{
		ID:        "fm1",
		ChatID:    "remote-chat-del3",
		FromID:    "local:localhost:8080",
		FromNick:  "local",
		Text:      "mine",
		CreatedAt: time.Now(),
	}
	if err := h.store.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodDelete,
		"/api/federated/chats/remote-chat-del3/messages/fm1", nil,
	)
	req.SetPathValue("id", "remote-chat-del3")
	req.SetPathValue("messageId", "fm1")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedDeleteMessage(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for local-authored message, got %d", w.Code)
	}
}

func TestFederatedHandleTyping(t *testing.T) {
	h := newTestHandler(t)
	setupRemoteChat(t, h, "remote-chat-typing")

	body := `{"userId":"remote:remote.test","nick":"remote","active":true}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats/remote-chat-typing/typing", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "remote-chat-typing")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedHandleTyping(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFederatedHandleTypingInvalidBody(t *testing.T) {
	h := newTestHandler(t)
	setupRemoteChat(t, h, "remote-chat-typing2")

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats/remote-chat-typing2/typing", strings.NewReader(`{bad`),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "remote-chat-typing2")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedHandleTyping(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestFederatedAuthMiddlewareMissingHeaders(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/federated/x", nil)
	w := httptest.NewRecorder()
	called := false
	h.FederatedAuthMiddleware(func(http.ResponseWriter, *http.Request) { called = true })(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if called {
		t.Fatal("handler should not be called without valid headers")
	}
}

func TestFederatedAuthMiddlewareBadTimestamp(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/federated/x", nil)
	req.Header.Set("X-Federation-Server", "remote.test")
	req.Header.Set("X-Federation-Signature", "abc")
	req.Header.Set("X-Federation-Timestamp", "not-a-number")

	w := httptest.NewRecorder()
	called := false
	h.FederatedAuthMiddleware(func(http.ResponseWriter, *http.Request) { called = true })(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if called {
		t.Fatal("handler should not be called with bad timestamp")
	}
}

func TestFederatedAuthMiddlewareStaleTimestamp(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/federated/x", nil)
	req.Header.Set("X-Federation-Server", "remote.test")
	req.Header.Set("X-Federation-Signature", "abc")
	req.Header.Set("X-Federation-Timestamp", "1000000")

	w := httptest.NewRecorder()
	called := false
	h.FederatedAuthMiddleware(func(http.ResponseWriter, *http.Request) { called = true })(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if called {
		t.Fatal("handler should not be called with stale timestamp")
	}
}
