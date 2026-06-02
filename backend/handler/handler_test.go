package handler

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &store.ChatMember{}, &model.Message{}, &model.Thread{}); err != nil {
		t.Fatal(err)
	}

	return store.New(db)
}

const testNickAlice = `{"nick":"alice"}`

func newTestHandler(t *testing.T) *Handler {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		MessageEditTTL:    300,
		MessageDeleteTTL:  0,
		ServerDomain:      "localhost:8080",
		CORSOrigin:        "*",
		FederationScheme:  "http",
		FederationTimeout: 5,
		FederationKeyPath: ".",
	}

	fm := federation.New(key, cfg.ServerDomain, cfg.FederationScheme, cfg.FederationTimeout)
	s := newTestStore(t)

	return New(s, cfg, fm)
}

func TestRegister(t *testing.T) {
	h := newTestHandler(t)

	body := testNickAlice
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Register(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", w.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	user, ok := resp["user"].(map[string]interface{})
	if !ok {
		t.Fatal("expected user in response")
	}
	if user["nick"] != "alice" {
		t.Errorf("expected nick 'alice', got %v", user["nick"])
	}
	if _, ok := resp["token"]; !ok {
		t.Error("expected token in response")
	}
}

func TestRegisterDuplicate(t *testing.T) {
	h := newTestHandler(t)

	body := testNickAlice

	req1 := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(body))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	h.Register(w1, req1)

	req2 := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	h.Register(w2, req2)

	if w2.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d", w2.Code)
	}
}

func TestRegisterValidation(t *testing.T) {
	h := newTestHandler(t)

	tests := []struct {
		name string
		body string
		code int
	}{
		{"empty nick", `{"nick":""}`, http.StatusBadRequest},
		{"too long", `{"nick":"abcdefghijklmnopqrstu"}`, http.StatusBadRequest},
		{"contains colon", `{"nick":"alice:bob"}`, http.StatusBadRequest},
		{"invalid json", `not json`, http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			h.Register(w, req)

			if w.Code != tc.code {
				t.Errorf("expected %d, got %d", tc.code, w.Code)
			}
		})
	}
}

func TestAuthMiddleware(t *testing.T) {
	h := newTestHandler(t)

	// Register a user to get a token
	body := testNickAlice
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Register(w, req)

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	token, _ := resp["token"].(string)

	handler := h.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		user := getUser(r)
		if user == nil {
			http.Error(w, "no user", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"user": user.ID})
	})

	t.Run("valid token", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		req.Header.Set("Authorization", "Bearer invalid")
		w := httptest.NewRecorder()
		handler(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("token in query", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/?token="+token, http.NoBody)
		w := httptest.NewRecorder()
		handler(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})
}

func TestCreateChat(t *testing.T) {
	h := newTestHandler(t)

	// Register two users
	regBody1 := `{"nick":"alice"}`
	req1 := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(regBody1))
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	h.Register(w1, req1)

	var resp1 map[string]interface{}
	json.Unmarshal(w1.Body.Bytes(), &resp1)
	aliceToken := resp1["token"].(string)
	aliceUser := resp1["user"].(map[string]interface{})
	aliceID := aliceUser["id"].(string)

	regBody2 := `{"nick":"bob"}`
	req2 := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(regBody2))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	h.Register(w2, req2)

	var resp2 map[string]interface{}
	json.Unmarshal(w2.Body.Bytes(), &resp2)
	bobID := resp2["user"].(map[string]interface{})["id"].(string)

	t.Run("create chat", func(t *testing.T) {
		body := `{"withUserId":"` + bobID + `"}`
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/chats", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.CreateChat)(w, req)

		if w.Code != http.StatusCreated {
			t.Errorf("expected 201, got %d: %s", w.Code, w.Body.String())
		}

		var chatResp map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &chatResp)
		chat := chatResp["chat"].(map[string]interface{})
		members := chat["members"].([]interface{})
		if len(members) != 2 {
			t.Errorf("expected 2 members, got %d", len(members))
		}
	})

	t.Run("chat with yourself", func(t *testing.T) {
		body := `{"withUserId":"` + aliceID + `"}`
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/chats", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+aliceToken)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.CreateChat)(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})

	t.Run("unauthorized", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/chats", http.NoBody)
		w := httptest.NewRecorder()

		h.AuthMiddleware(h.CreateChat)(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}

func TestGetMessages(t *testing.T) {
	h := newTestHandler(t)

	regBody := `{"nick":"alice"}`
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Register(w, req)

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)
	aliceToken := resp["token"].(string)

	// Register bob
	bobReq := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/register", strings.NewReader(`{"nick":"bob"}`))
	bobReq.Header.Set("Content-Type", "application/json")
	bobW := httptest.NewRecorder()
	h.Register(bobW, bobReq)
	var bobResp map[string]interface{}
	json.Unmarshal(bobW.Body.Bytes(), &bobResp)
	bobID := bobResp["user"].(map[string]interface{})["id"].(string)

	// Create chat
	chatBody := `{"withUserId":"` + bobID + `"}`
	chatReq := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/chats", strings.NewReader(chatBody))
	chatReq.Header.Set("Content-Type", "application/json")
	chatReq.Header.Set("Authorization", "Bearer "+aliceToken)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)
	var chatResp map[string]interface{}
	json.Unmarshal(chatW.Body.Bytes(), &chatResp)
	chatID := chatResp["chat"].(map[string]interface{})["id"].(string)

	// Send message
	msgBody := `{"text":"hello"}`
	msgReq := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/chats/"+chatID+"/messages", strings.NewReader(msgBody))
	msgReq.Header.Set("Content-Type", "application/json")
	msgReq.Header.Set("Authorization", "Bearer "+aliceToken)
	msgReq.SetPathValue("id", chatID)
	msgW := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(msgW, msgReq)

	if msgW.Code != http.StatusCreated {
		t.Errorf("expected 201 sending message, got %d", msgW.Code)
	}

	// Get messages
	getReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/chats/"+chatID+"/messages", http.NoBody)
	getReq.Header.Set("Authorization", "Bearer "+aliceToken)
	getReq.SetPathValue("id", chatID)
	getW := httptest.NewRecorder()
	h.AuthMiddleware(h.GetMessages)(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", getW.Code)
	}

	var getResp map[string]interface{}
	json.Unmarshal(getW.Body.Bytes(), &getResp)
	msgs, ok := getResp["messages"].([]interface{})
	if !ok {
		t.Fatal("expected messages array")
	}
	if len(msgs) != 1 {
		t.Errorf("expected 1 message, got %d", len(msgs))
	}
}

func TestGetConfig(t *testing.T) {
	h := newTestHandler(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/config", http.NoBody)
	w := httptest.NewRecorder()
	h.GetConfig(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["messageEditTTL"] != float64(300) {
		t.Errorf("expected messageEditTTL=300, got %v", resp["messageEditTTL"])
	}
}

func TestRemoteServerFromID(t *testing.T) {
	tests := []struct {
		id   string
		want string
	}{
		{"alice:localhost:8080", "localhost:8080"},
		{"bob:example.com:9090", "example.com:9090"},
		{"localuser", ""},
		{"", ""},
		{"onlycolon:", ""},
	}

	for _, tc := range tests {
		got := remoteServerFromID(tc.id)
		if got != tc.want {
			t.Errorf("remoteServerFromID(%q): got %q, want %q", tc.id, got, tc.want)
		}
	}
}

func TestIsMember(t *testing.T) {
	chat := &model.Chat{
		ID:      "chat1",
		Members: []string{"alice", "bob"},
	}

	if !isMember(chat, "alice") {
		t.Error("expected alice to be a member")
	}
	if !isMember(chat, "bob") {
		t.Error("expected bob to be a member")
	}
	if isMember(chat, "carol") {
		t.Error("expected carol to not be a member")
	}
}
