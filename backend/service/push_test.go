package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

func newPushTestService(t *testing.T) *Service {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Chat{}, &store.ChatMember{},
		&model.Message{}, &model.Thread{}, &model.File{},
		&model.MessageFile{}, &model.DeletedMessage{},
		&model.DeletedChat{}, &model.PushSubscription{},
		&model.MessageReadStatus{},
	); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		Server:   config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:     config.CORSConfig{Origin: "*"},
		Database: config.DatabaseConfig{Path: ":memory:"},
	}

	return New(store.New(db), cfg, sse.NewHub(time.Minute), nil)
}

type mockPushService struct {
	sent chan []byte
}

func (m *mockPushService) SendToUser(payload []byte, _ []model.PushSubscription) {
	select {
	case m.sent <- payload:
	default:
	}
}

func (m *mockPushService) PublicKey() string { return "pk" }

func TestSendPushForMessageNilServiceIsNoop(t *testing.T) {
	s := newPushTestService(t)
	// push is nil by default: must not panic.
	s.SendPushForMessage(context.Background(), "c1", nil, "", "alice:localhost:8080")
}

func TestSendPushForMessageOnlineRecipientSkipped(t *testing.T) {
	s := newPushTestService(t)

	svc := &mockPushService{sent: make(chan []byte, 1)}
	s.push = svc

	alice := registerPushTestUser(t, s, "alice")

	// Mark alice as online so SendToUser is never invoked.
	s.store.AddConnection(alice.ID)

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: alice.ID, FromNick: "alice"}
	s.SendPushForMessage(context.Background(), "c1", msg, "", alice.ID)

	select {
	case <-svc.sent:
		t.Fatal("online recipient must not trigger push")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSendPushForMessageOfflineWithSubscriptions(t *testing.T) {
	s := newPushTestService(t)

	mock := &mockPushService{sent: make(chan []byte, 1)}
	s.push = mock

	alice := registerPushTestUser(t, s, "alice")

	// Seed a subscription for alice (who is offline by default).
	if _, err := s.store.AddPushSubscription(context.Background(), alice.ID, "https://fcm.googleapis.com/fcm/send/xyz", "dGVzdA==", "aHVl"); err != nil {
		t.Fatal(err)
	}

	msg := &model.Message{ID: "m1", ChatID: "c1", FromID: alice.ID, FromNick: "alice"}
	s.SendPushForMessage(context.Background(), "c1", msg, "", alice.ID)

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

func registerPushTestUser(t *testing.T, s *Service, nick string) *model.User {
	t.Helper()

	user, err := s.store.CreateUser(context.Background(), nick+"@test.local", nick, "localhost:8080", time.Hour)
	if err != nil {
		t.Fatalf("create user %s: %v", nick, err)
	}

	return user
}
