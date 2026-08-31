package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fast_chat/model"
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

func TestSendPushForMessageNilServiceIsNoop(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	// pushSender is nil in the default test handler: must not panic.
	h.sendPushForMessage(context.Background(), "c1", nil, "", alice.id)
}

func TestSendPushForMessageOnlineRecipientSkipped(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	svc, err := push.NewService("test@test.local", t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	h.pushSender = svc

	// Mark alice as online so SendToUser is never invoked.
	h.store.AddConnection(alice.id)

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: alice.id, FromNick: "alice"}
	h.sendPushForMessage(context.Background(), "c1", msg, "", alice.id)
}

type mockPushService struct {
	sent   chan []byte
	public string
}

func (m *mockPushService) SendToUser(payload []byte, _ []model.PushSubscription) {
	select {
	case m.sent <- payload:
	default:
	}
}

func (m *mockPushService) PublicKey() string { return m.public }

func TestSendPushForMessageOfflineWithSubscriptions(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	mock := &mockPushService{sent: make(chan []byte, 1), public: "pk"}
	h.pushSender = mock

	// Seed a subscription for alice (who is offline by default).
	if _, err := h.store.AddPushSubscription(context.Background(), alice.id, "https://fcm.googleapis.com/fcm/send/xyz", "dGVzdA==", "aHVl"); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: alice.id, FromNick: "alice"}
	h.sendPushForMessage(context.Background(), "c1", msg, "", alice.id)

	select {
	case payload := <-mock.sent:
		if !strings.Contains(string(payload), `"messageId":"m1"`) {
			t.Errorf("unexpected push payload: %s", payload)
		}
		if !strings.Contains(string(payload), `"chatId":"c1"`) {
			t.Errorf("push payload missing chatId: %s", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("expected SendToUser to be called for offline recipient with subscriptions")
	}
}
