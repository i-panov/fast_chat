package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fast_chat/push"
)

func TestVapidPublicKeyNotConfigured(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	req := authReq(http.MethodGet, "/api/push/vapid-public-key", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.VapidPublicKey)(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when push not configured, got %d", w.Code)
	}
}

func TestVapidPublicKeyConfigured(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	svc, err := push.NewService("test@test.local", t.TempDir(), nil)
	if err != nil {
		t.Fatalf("new push service: %v", err)
	}

	h.pushSender = svc

	req := authReq(http.MethodGet, "/api/push/vapid-public-key", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.VapidPublicKey)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if !strings.Contains(w.Body.String(), "publicKey") {
		t.Errorf("expected publicKey field, got %s", w.Body.String())
	}
}
