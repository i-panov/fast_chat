package transport

import (
	"context"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/glebarez/sqlite"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

func newTestDB(t *testing.T) *gorm.DB {
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
		&model.FederationOp{}, &model.FederationCursor{},
	); err != nil {
		t.Fatal(err)
	}

	return db
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()

	st := store.New(newTestDB(t))
	st.Codes().StartCleanup(context.Background(), time.Minute)

	return st
}

func newTestHub() *sse.Hub {
	return sse.NewHub(time.Minute)
}

func testAPIConfig() *config.Config {
	return &config.Config{
		Server:           config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:             config.CORSConfig{Origin: "*"},
		Auth:             config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
		Email:            config.EmailConfig{DebugMode: false},
		MessageEditTTL:   300,
		MessageDeleteTTL: 0,
	}
}

func newTestMux() *chi.Mux {
	return chi.NewMux()
}

func newTestAPI(mux *chi.Mux) huma.API { //nolint:ireturn // huma.API is the required interface
	humaConfig := newHumaConfig("Test API", "1.0.0")
	humaConfig.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		bearerScheme: {Type: "http", Scheme: "bearer", BearerFormat: "JWT"},
	}

	return humachi.New(mux, humaConfig)
}

func newTestService(st *store.Store, hub *sse.Hub) *service.Service {
	return service.New(st, testAPIConfig(), hub, nil)
}

// createTestUser creates a user (plus self-chat) through the given store and
// returns it with the plaintext token set, as sent to a client.
func createTestUser(t *testing.T, st *store.Store) *model.User {
	t.Helper()

	user, err := st.CreateUser(context.Background(), "alice@test.local", "alice", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := st.EnsureSelfChat(context.Background(), user.ID); err != nil {
		t.Fatal(err)
	}

	return user
}
