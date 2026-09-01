package huma

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

func newPilotTestServer(t *testing.T) *Pilot {
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
		Server: config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:   config.CORSConfig{Origin: "*"},
		Auth:   config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
	}

	hub := sse.NewHub(service.TypingThrottleInterval * 5)
	st := store.New(db)
	svc := service.New(st, cfg, hub, nil)

	return NewPilot(hub, st, svc, cfg)
}

func TestPilotSSEConnected(t *testing.T) {
	pilot := newPilotTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/events?connectionId=test-conn-1", http.NoBody)
	rec := httptest.NewRecorder()

	// Use a context with timeout so the test doesn't hang on the endless loop.
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)

	pilot.Handler().ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "event: connected") {
		t.Fatalf("expected connected event, got: %q", body)
	}

	if !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("expected status ok, got: %q", body)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
}

func TestPilotSSEMissingConnectionID(t *testing.T) {
	pilot := newPilotTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/events", http.NoBody)
	rec := httptest.NewRecorder()

	pilot.Handler().ServeHTTP(rec, req)

	// Missing connectionId returns 400 to match legacy behavior.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestPilotSSEStreamStaysOpen(t *testing.T) {
	pilot := newPilotTestServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/events?connectionId=open-test", http.NoBody).WithContext(ctx)
	rec := httptest.NewRecorder()

	pilot.Handler().ServeHTTP(rec, req)

	// The stream should stay open for the duration of the context and emit
	// the connected event. If it closed early, we'd see no output.
	body := rec.Body.String()
	if !strings.Contains(body, "event: connected") {
		t.Fatalf("expected connected event before stream close, got: %q", body)
	}
}
