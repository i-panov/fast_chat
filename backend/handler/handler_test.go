package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

const testChatTypeGroup = "group"

func newTestStore(t *testing.T) *store.Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}

	if err := db.AutoMigrate(&model.User{}, &model.Chat{}, &store.ChatMember{}, &model.Message{}, &model.Thread{}, &model.File{}, &model.MessageFile{}, &model.DeletedMessage{}, &model.DeletedChat{}, &model.PushSubscription{}, &model.MessageReadStatus{}); err != nil {
		t.Fatal(err)
	}

	return store.New(db)
}

func newTestHandler(t *testing.T) *Handler {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		MessageEditTTL:   300,
		MessageDeleteTTL: 0,
		Server:           config.ServerConfig{Domain: "localhost:8080", Port: 8080},
		CORS:             config.CORSConfig{Origin: "*"},
		Federation:       config.FederationConfig{Scheme: "http", Timeout: 5, KeyPath: "."},
		Uploads:          config.UploadsConfig{Dir: "."},
		Database:         config.DatabaseConfig{Path: "test.db"},
		Auth:             config.AuthConfig{TokenExpiry: 24 * time.Hour, TokenExpiryWarning: 5 * time.Minute},
		Email:            config.EmailConfig{DebugMode: true},
	}

	fm := federation.New(key, cfg.Server.Domain, cfg.Federation.Scheme, cfg.Federation.Timeout)
	s := newTestStore(t)

	return New(s, cfg, fm, nil)
}

func TestSearchUsersDoesNotLeakToken(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	req := authReq(http.MethodGet, "/api/users/search?q=bo", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if bytes.Contains(w.Body.Bytes(), []byte("token")) {
		t.Errorf("search response must not include token field; body: %s", w.Body.String())
	}
	if bytes.Contains(w.Body.Bytes(), []byte(bob.token)) {
		t.Errorf("search response must not include bob's actual token; body: %s", w.Body.String())
	}
}

func TestFederatedSearchUsersDoesNotLeakToken(t *testing.T) {
	h := newTestHandler(t)

	registerTestUser(t, h, "alice", "alice@test.local")
	registerTestUser(t, h, "bob", "bob@test.local")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/federated/users/search?q=al", http.NoBody)
	w := httptest.NewRecorder()
	h.FederatedSearchUsers(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if bytes.Contains(w.Body.Bytes(), []byte("token")) {
		t.Errorf("federated search response must not include token field; body: %s", w.Body.String())
	}
}

func TestAuthMiddleware(t *testing.T) {
	h := newTestHandler(t)

	alice := registerTestUser(t, h, "alice", "alice@test.local")

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
		req.Header.Set("Authorization", "Bearer "+alice.token)
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

	t.Run("token in query is rejected", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/?token="+alice.token, http.NoBody)
		w := httptest.NewRecorder()
		handler(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}

func TestCreateChat(t *testing.T) {
	h := newTestHandler(t)

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	run := func(name string, body string, expected int) {
		t.Run(name, func(t *testing.T) {
			req := authReq(http.MethodPost, "/api/chats", alice.token, body)
			w := httptest.NewRecorder()
			h.AuthMiddleware(h.CreateChat)(w, req)

			if w.Code != expected {
				t.Errorf("expected %d, got %d: %s", expected, w.Code, w.Body.String())
			}
		})
	}

	run("create chat", `{"withUserId":"`+bob.id+`"}`, http.StatusCreated)
	run("chat with yourself", `{"withUserId":"`+alice.id+`"}`, http.StatusBadRequest)
}

func TestGetMessages(t *testing.T) {
	h := newTestHandler(t)

	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	// Create chat
	chatBody := `{"withUserId":"` + bob.id + `"}`
	chatReq := authReq(http.MethodPost, "/api/chats", alice.token, chatBody)
	chatW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(chatW, chatReq)
	var chatResp map[string]any
	json.Unmarshal(chatW.Body.Bytes(), &chatResp)
	chatID := chatResp["chat"].(map[string]any)["id"].(string)

	// Send message
	msgReq := authReq(http.MethodPost, "/api/chats/"+chatID+"/messages", alice.token, `{"text":"hello"}`)
	msgReq.SetPathValue("id", chatID)
	msgW := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(msgW, msgReq)

	if msgW.Code != http.StatusCreated {
		t.Errorf("expected 201 sending message, got %d", msgW.Code)
	}

	// Get messages
	getReq := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/chats/"+chatID+"/messages", http.NoBody)
	getReq.Header.Set("Authorization", "Bearer "+alice.token)
	getReq.SetPathValue("id", chatID)
	getW := httptest.NewRecorder()
	h.AuthMiddleware(h.GetMessages)(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", getW.Code)
	}

	var getResp map[string]any
	json.Unmarshal(getW.Body.Bytes(), &getResp)
	msgs, ok := getResp["messages"].([]any)
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

	var resp map[string]any
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
		got := service.RemoteServerFromID(tc.id)
		if got != tc.want {
			t.Errorf("remoteServerFromID(%q): got %q, want %q", tc.id, got, tc.want)
		}
	}
}

type testAccount struct {
	token string
	id    string
}

func registerTestUser(t *testing.T, h *Handler, nick, email string) testAccount {
	t.Helper()

	user, err := h.store.CreateUser(context.Background(), email, nick, h.cfg.Server.Domain, h.cfg.Auth.TokenExpiry)
	if err != nil {
		t.Fatalf("create user %s: %v", nick, err)
	}

	return testAccount{
		token: user.Token,
		id:    user.ID,
	}
}

func authReq(method, path, token, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequestWithContext(context.Background(), method, path, http.NoBody)
	} else {
		r = httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Authorization", "Bearer "+token)
	return r
}

func TestCreateGroupChat(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")
	carol := registerTestUser(t, h, "carol", "carol@test.local")

	body := `{"type":"group","name":"Team","memberIds":["` + bob.id + `","` + carol.id + `"]}`
	req := authReq(http.MethodPost, "/api/chats", alice.token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	chat := resp["chat"].(map[string]any)

	if chat["type"] != testChatTypeGroup {
		t.Errorf("expected type=group, got %v", chat["type"])
	}
	if chat["name"] != "Team" {
		t.Errorf("expected name=Team, got %v", chat["name"])
	}
	if chat["ownerId"] != alice.id {
		t.Errorf("expected ownerId=%s, got %v", alice.id, chat["ownerId"])
	}
	members := chat["members"].([]any)
	if len(members) != 3 {
		t.Errorf("expected 3 members, got %d", len(members))
	}
}

func TestCreateGroupChat_RejectsFederatedMember(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	body := `{"type":"group","name":"X","memberIds":["` + bob.id + `","carol:other.com:9999"]}`
	req := authReq(http.MethodPost, "/api/chats", alice.token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for federated member, got %d", w.Code)
	}
}

func TestCreateGroupChat_Validation(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	tests := []struct {
		name string
		body string
		code int
	}{
		{"empty name", `{"type":"group","name":"","memberIds":["` + bob.id + `"]}`, http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := authReq(http.MethodPost, "/api/chats", alice.token, tc.body)
			w := httptest.NewRecorder()
			h.AuthMiddleware(h.CreateChat)(w, req)
			if w.Code != tc.code {
				t.Errorf("expected %d, got %d", tc.code, w.Code)
			}
		})
	}
}

func TestCreateGroupChat_Solo(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	body := `{"type":"group","name":"Solo","memberIds":[]}`
	req := authReq(http.MethodPost, "/api/chats", alice.token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	chat := resp["chat"].(map[string]any)

	if chat["ownerId"] != alice.id {
		t.Errorf("expected ownerId=%s, got %v", alice.id, chat["ownerId"])
	}
	members := chat["members"].([]any)
	if len(members) != 1 {
		t.Errorf("expected 1 member, got %d", len(members))
	}
}

func TestGroupPermissions(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")
	carol := registerTestUser(t, h, "carol", "carol@test.local")

	createBody := `{"type":"group","name":"G","memberIds":["` + bob.id + `","` + carol.id + `"]}`
	createReq := authReq(http.MethodPost, "/api/chats", alice.token, createBody)
	createW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", createW.Code, createW.Body.String())
	}
	var created map[string]any
	json.Unmarshal(createW.Body.Bytes(), &created)
	chatID := created["chat"].(map[string]any)["id"].(string)

	t.Run("owner can rename", func(t *testing.T) {
		req := authReq(http.MethodPatch, "/api/chats/"+chatID, alice.token, `{"name":"New"}`)
		req.SetPathValue("id", chatID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.UpdateChat)(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("non-owner cannot rename", func(t *testing.T) {
		req := authReq(http.MethodPatch, "/api/chats/"+chatID, bob.token, `{"name":"Hack"}`)
		req.SetPathValue("id", chatID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.UpdateChat)(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", w.Code)
		}
	})

	t.Run("non-member cannot rename", func(t *testing.T) {
		dave := registerTestUser(t, h, "dave", "dave@test.local")
		req := authReq(http.MethodPatch, "/api/chats/"+chatID, dave.token, `{"name":"X"}`)
		req.SetPathValue("id", chatID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.UpdateChat)(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", w.Code)
		}
	})

	t.Run("owner can add", func(t *testing.T) {
		dave := registerTestUser(t, h, "dave2", "dave2@test.local")
		body := `{"userId":"` + dave.id + `"}`
		req := authReq(http.MethodPost, "/api/chats/"+chatID+"/members", alice.token, body)
		req.SetPathValue("id", chatID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.AddChatMember)(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("non-owner cannot add", func(t *testing.T) {
		eve := registerTestUser(t, h, "eve", "eve@test.local")
		body := `{"userId":"` + eve.id + `"}`
		req := authReq(http.MethodPost, "/api/chats/"+chatID+"/members", bob.token, body)
		req.SetPathValue("id", chatID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.AddChatMember)(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", w.Code)
		}
	})

	t.Run("owner cannot leave", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/chats/"+chatID+"/members/"+alice.id, http.NoBody)
		req.Header.Set("Authorization", "Bearer "+alice.token)
		req.SetPathValue("id", chatID)
		req.SetPathValue("userId", alice.id)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.RemoveChatMember)(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})

	t.Run("member can leave (self-remove)", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/chats/"+chatID+"/members/"+carol.id, http.NoBody)
		req.Header.Set("Authorization", "Bearer "+carol.token)
		req.SetPathValue("id", chatID)
		req.SetPathValue("userId", carol.id)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.RemoveChatMember)(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("member cannot remove other", func(t *testing.T) {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/chats/"+chatID+"/members/"+alice.id, http.NoBody)
		req.Header.Set("Authorization", "Bearer "+bob.token)
		req.SetPathValue("id", chatID)
		req.SetPathValue("userId", alice.id)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.RemoveChatMember)(w, req)
		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", w.Code)
		}
	})
}

func TestDeleteGroupChat(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")
	carol := registerTestUser(t, h, "carol", "carol@test.local")

	createBody := `{"type":"group","name":"G","memberIds":["` + bob.id + `","` + carol.id + `"]}`
	createReq := authReq(http.MethodPost, "/api/chats", alice.token, createBody)
	createW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(createW, createReq)
	var created map[string]any
	json.Unmarshal(createW.Body.Bytes(), &created)
	chatID := created["chat"].(map[string]any)["id"].(string)

	// non-owner cannot delete
	req := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/chats/"+chatID, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+bob.token)
	req.SetPathValue("id", chatID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteChat)(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("non-owner delete: expected 403, got %d", w.Code)
	}

	// owner can delete
	req2 := httptest.NewRequestWithContext(context.Background(), http.MethodDelete, "/api/chats/"+chatID, http.NoBody)
	req2.Header.Set("Authorization", "Bearer "+alice.token)
	req2.SetPathValue("id", chatID)
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(h.DeleteChat)(w2, req2)
	if w2.Code != http.StatusOK {
		t.Errorf("owner delete: expected 200, got %d", w2.Code)
	}

	// chat is gone
	req3 := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/chats/"+chatID, http.NoBody)
	req3.Header.Set("Authorization", "Bearer "+alice.token)
	req3.SetPathValue("id", chatID)
	w3 := httptest.NewRecorder()
	h.AuthMiddleware(h.GetChat)(w3, req3)
	if w3.Code != http.StatusNotFound {
		t.Errorf("after delete: expected 404, got %d", w3.Code)
	}
}

func TestServeFileForGroupAvatar(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")
	carol := registerTestUser(t, h, "carol", "carol@test.local")

	createBody := `{"type":"group","name":"G","memberIds":["` + bob.id + `","` + carol.id + `"]}`
	createReq := authReq(http.MethodPost, "/api/chats", alice.token, createBody)
	createW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(createW, createReq)
	var created map[string]any
	json.Unmarshal(createW.Body.Bytes(), &created)
	chatID := created["chat"].(map[string]any)["id"].(string)

	f, _ := h.store.SaveFile(context.Background(), "avatar-hash", "image/png", 70, "a.png", "a.png")

	req := authReq(http.MethodPost, "/api/chats/"+chatID+"/avatar", alice.token, `{"fileId":"`+f.ID+`"}`)
	req.SetPathValue("id", chatID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.UpdateChatAvatar)(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("set avatar: %d %s", w.Code, w.Body.String())
	}

	if !h.svc.UserCanAccessFile(context.Background(), bob.id, f.ID) {
		t.Error("expected bob to access group avatar")
	}
	if h.svc.UserCanAccessFile(context.Background(), bob.id, "no-such-file") {
		t.Error("expected no access for unknown file")
	}

	eve := registerTestUser(t, h, "eve", "eve@test.local")
	if h.svc.UserCanAccessFile(context.Background(), eve.id, f.ID) {
		t.Error("expected eve (non-member) to NOT access group avatar")
	}
}

func TestPrivateChatUnaffectedByGroup(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")
	carol := registerTestUser(t, h, "carol", "carol@test.local")

	// Create a group with all three
	createBody := `{"type":"group","name":"All","memberIds":["` + bob.id + `","` + carol.id + `"]}`
	createReq := authReq(http.MethodPost, "/api/chats", alice.token, createBody)
	createW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("group create: %d %s", createW.Code, createW.Body.String())
	}

	// Now alice tries to open private chat with bob - should be a NEW chat (type=private)
	privBody := `{"withUserId":"` + bob.id + `"}`
	privReq := authReq(http.MethodPost, "/api/chats", alice.token, privBody)
	privW := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(privW, privReq)
	if privW.Code != http.StatusCreated {
		t.Fatalf("private create: %d %s", privW.Code, privW.Body.String())
	}
	var privResp map[string]any
	json.Unmarshal(privW.Body.Bytes(), &privResp)
	privChat := privResp["chat"].(map[string]any)
	if privChat["type"] != "private" {
		t.Errorf("expected private, got %v", privChat["type"])
	}

	// And second call returns the SAME private chat (uniqueness)
	privReq2 := authReq(http.MethodPost, "/api/chats", alice.token, privBody)
	privW2 := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(privW2, privReq2)
	if privW2.Code != http.StatusCreated {
		t.Fatalf("private create2: %d", privW2.Code)
	}
	var privResp2 map[string]any
	json.Unmarshal(privW2.Body.Bytes(), &privResp2)
	if privResp2["chat"].(map[string]any)["id"] != privChat["id"] {
		t.Error("expected same private chat id on second call")
	}
}

func TestFederatedSendMessageRejectsMismatchedFromID(t *testing.T) {
	h := newTestHandler(t)

	chat := &model.Chat{
		ID:           "remote-chat-1",
		Members:      []string{"alice:remote.test", "bob:localhost:8080"},
		CreatedAt:    time.Now(),
		RemoteServer: "remote.test",
	}
	h.store.CreateRemoteChat(context.Background(), chat)

	body := `{"id":"m1","fromId":"alice:other.test","fromNick":"alice","text":"hi"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats/remote-chat-1/messages", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", "remote.test")
	req.SetPathValue("id", "remote-chat-1")

	w := httptest.NewRecorder()
	h.FederatedSendMessage(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFederatedSendMessageRejectsWrongServerHeader(t *testing.T) {
	h := newTestHandler(t)

	chat := &model.Chat{
		ID:           "remote-chat-2",
		Members:      []string{"alice:remote.test", "bob:localhost:8080"},
		CreatedAt:    time.Now(),
		RemoteServer: "remote.test",
	}
	h.store.CreateRemoteChat(context.Background(), chat)

	body := `{"id":"m1","fromId":"alice:remote.test","fromNick":"alice","text":"hi"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats/remote-chat-2/messages", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", "evil.test")
	req.SetPathValue("id", "remote-chat-2")

	w := httptest.NewRecorder()
	h.FederatedSendMessage(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFederatedCreateChatRejectsMismatchedRemoteServer(t *testing.T) {
	h := newTestHandler(t)

	body := `{"chatId":"x1","members":["a:remote.test","b:localhost:8080"],"remoteServer":"remote.test"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", "evil.test")

	w := httptest.NewRecorder()
	h.FederatedCreateChat(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFederatedCreateChatRejectsUnfederatedMembers(t *testing.T) {
	h := newTestHandler(t)

	body := `{"chatId":"x2","members":["alice","bob:localhost:8080"],"remoteServer":"remote.test"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost,
		"/api/federated/chats", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", "remote.test")

	w := httptest.NewRecorder()
	h.FederatedCreateChat(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFederatedEditMessageRejectsLocalAuthor(t *testing.T) {
	h := newTestHandler(t)

	chat := &model.Chat{
		ID:           "remote-chat-3",
		Members:      []string{"alice:remote.test", "bob:localhost:8080"},
		CreatedAt:    time.Now(),
		RemoteServer: "remote.test",
	}
	h.store.CreateRemoteChat(context.Background(), chat)

	msg := &model.Message{
		ID:        "m1",
		ChatID:    "remote-chat-3",
		FromID:    "bob:localhost:8080",
		FromNick:  "bob",
		Text:      "original",
		CreatedAt: time.Now(),
	}
	if err := h.store.AddRawMessage(context.Background(), msg); err != nil {
		t.Fatal(err)
	}

	body := `{"text":"hijacked"}`
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPatch,
		"/api/federated/chats/remote-chat-3/messages/m1", strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", "remote.test")
	req.SetPathValue("id", "remote-chat-3")
	req.SetPathValue("messageId", "m1")

	w := httptest.NewRecorder()
	h.FederatedEditMessage(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSearchUsersRejectsShortQuery(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	registerTestUser(t, h, "bob", "bob@test.local")

	for _, q := range []string{"", "a", "  "} {
		req := authReq(http.MethodGet, "/api/users/search?q="+url.QueryEscape(q), alice.token, "")
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.SearchUsers)(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("q=%q: expected 200, got %d", q, w.Code)
		}

		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}

		users, _ := resp["users"].([]any)
		if len(users) != 0 {
			t.Errorf("q=%q: expected empty users, got %d", q, len(users))
		}
	}

	// Two runes must work.
	req := authReq(http.MethodGet, "/api/users/search?q=bo", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SearchUsers)(w, req)

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	users, _ := resp["users"].([]any)
	if len(users) != 1 {
		t.Errorf("q=al: expected 1 result, got %d", len(users))
	}
}

func TestFederatedSearchUsersRejectsShortQuery(t *testing.T) {
	h := newTestHandler(t)
	registerTestUser(t, h, "alice", "alice@test.local")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/federated/users/search?q=a", http.NoBody)
	w := httptest.NewRecorder()
	h.FederatedSearchUsers(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	users, _ := resp["users"].([]any)
	if len(users) != 0 {
		t.Errorf("expected empty users for short query, got %d", len(users))
	}
}

func TestHealthzHandler(t *testing.T) {
	w := httptest.NewRecorder()
	HealthzHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if resp["status"] != "ok" {
		t.Errorf("expected status=ok, got %q", resp["status"])
	}
}

func TestReadinessHandler(t *testing.T) {
	h := newTestHandler(t)

	w := httptest.NewRecorder()
	h.ReadinessHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/readyz", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if resp["status"] != "ready" {
		t.Errorf("expected status=ready, got %q", resp["status"])
	}
}
