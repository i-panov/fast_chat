package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"fast_chat/model"
)

// A valid X25519 public key: 32 zero bytes, base64-encoded.
const testPublicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

func createTestChat(t *testing.T, h *Handler, token, withUserID string) *model.Chat {
	t.Helper()

	body := `{"withUserId":"` + withUserID + `"}`
	req := authReq(http.MethodPost, "/api/chats", token, body)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.CreateChat)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("chat create: %d %s", w.Code, w.Body.String())
	}

	var resp struct {
		Chat *model.Chat `json:"chat"`
	}

	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	return resp.Chat
}

func TestUpdateAndGetPublicKey(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	putReq := authReq(http.MethodPut, "/api/users/public-key", alice.token, `{"publicKey":"`+testPublicKey+`"}`)
	putW := httptest.NewRecorder()
	h.AuthMiddleware(h.UpdatePublicKey)(putW, putReq)

	if putW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", putW.Code, putW.Body.String())
	}

	// Stored on the user record.
	key, ok := h.store.GetUserPublicKey(context.Background(), alice.id)
	if !ok || key != testPublicKey {
		t.Fatalf("expected stored key %q, got %q (ok=%v)", testPublicKey, key, ok)
	}

	// And served back via the public endpoint.
	getReq := authReq(http.MethodGet, "/api/users/"+alice.id+"/public-key", alice.token, "")
	getReq.SetPathValue("userId", alice.id)
	getW := httptest.NewRecorder()
	h.AuthMiddleware(h.GetUserPublicKey)(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", getW.Code, getW.Body.String())
	}

	var resp struct {
		PublicKey string `json:"publicKey"`
	}

	if err := json.Unmarshal(getW.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.PublicKey != testPublicKey {
		t.Fatalf("expected %q, got %q", testPublicKey, resp.PublicKey)
	}
}

func TestUpdatePublicKeyAcceptsURLSafeBase64(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	// libsodium's default encoding is URLSAFE_NO_PADDING: 0xFF bytes
	// produce "-"/"_" characters instead of "+"/"/".
	urlSafeKey := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, 32))

	putReq := authReq(http.MethodPut, "/api/users/public-key", alice.token, `{"publicKey":"`+urlSafeKey+`"}`)
	putW := httptest.NewRecorder()
	h.AuthMiddleware(h.UpdatePublicKey)(putW, putReq)

	if putW.Code != http.StatusOK {
		t.Fatalf("expected 200 for URL-safe key, got %d: %s", putW.Code, putW.Body.String())
	}

	key, ok := h.store.GetUserPublicKey(context.Background(), alice.id)
	// The server stores a normalized (StdEncoding) form of the key so
	// clients that only understand standard base64 can use it.
	normalized := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, 32))
	if !ok || key != normalized {
		t.Fatalf("expected stored key %q, got %q (ok=%v)", normalized, key, ok)
	}
}

func TestUpdatePublicKeyRejectsInvalid(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	for _, body := range []string{
		`{"publicKey":"not-base64!!"}`,
		`{"publicKey":"` + base64.StdEncoding.EncodeToString([]byte("too short")) + `"}`,
		`{}`,
	} {
		req := authReq(http.MethodPut, "/api/users/public-key", alice.token, body)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.UpdatePublicKey)(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for %s, got %d", body, w.Code)
		}
	}
}

func TestGetPublicKeyForUserWithoutKeyReturns404(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	getReq := authReq(http.MethodGet, "/api/users/"+bob.id+"/public-key", alice.token, "")
	getReq.SetPathValue("userId", bob.id)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.GetUserPublicKey)(w, getReq)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestFederatedGetUserPublicKey(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	if err := h.store.UpdateUserPublicKey(context.Background(), alice.id, testPublicKey); err != nil {
		t.Fatal(err)
	}

	// A local user served to a remote server.
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/federated/users/"+alice.id+"/public-key", http.NoBody)
	req.SetPathValue("userId", alice.id)
	req.Header.Set("X-Federation-Server", "remote.example.com")
	w := httptest.NewRecorder()
	h.FederatedGetUserPublicKey(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		PublicKey string `json:"publicKey"`
	}

	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.PublicKey != testPublicKey {
		t.Fatalf("expected %q, got %q", testPublicKey, resp.PublicKey)
	}

	// A user belonging to another server must be rejected.
	foreign := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/federated/users/bob:remote.example.com/public-key", http.NoBody)
	foreign.SetPathValue("userId", "bob:remote.example.com")
	foreign.Header.Set("X-Federation-Server", "remote.example.com")
	foreignW := httptest.NewRecorder()
	h.FederatedGetUserPublicKey(foreignW, foreign)

	if foreignW.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for foreign user, got %d", foreignW.Code)
	}
}

func TestSendEncryptedMessage(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat := createTestChat(t, h, alice.token, bob.id)

	// The server must store ciphertext + payload verbatim; it never sees
	// the plaintext.
	nonce24 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 24))
	box48 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 48))
	payload := `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + alice.id + `","box":"` + box48 + `"}]}`

	body, err := json.Marshal(map[string]any{
		"id":               "msg-enc",
		"text":             "Y2lwaGVydGV4dA==",
		"encrypted":        true,
		"encryptedPayload": payload,
	})
	if err != nil {
		t.Fatal(err)
	}

	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages", alice.token, string(body))
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	msg, err := h.store.GetMessage(context.Background(), chat.ID, "msg-enc")
	if err != nil {
		t.Fatal(err)
	}

	if !msg.Encrypted {
		t.Fatal("expected message to be marked encrypted")
	}

	if msg.Text != "Y2lwaGVydGV4dA==" {
		t.Fatalf("expected ciphertext stored, got %q", msg.Text)
	}

	if !strings.Contains(msg.EncryptedPayload, `"v":1`) {
		t.Fatalf("expected payload stored, got %q", msg.EncryptedPayload)
	}
}

func TestEncryptedMessageLengthCap(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat := createTestChat(t, h, alice.token, bob.id)

	longText := strings.Repeat("x", maxMessageLen+1)

	// Plaintext longer than maxMessageLen is rejected.
	plainReq := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages", alice.token, `{"text":"`+longText+`"}`)
	plainReq.SetPathValue("id", chat.ID)
	plainW := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(plainW, plainReq)
	if plainW.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for long plaintext, got %d", plainW.Code)
	}

	// Ciphertext of the same length is fine (the client enforces the
	// plaintext limit before encrypting). The payload must be a
	// well-formed envelope.
	nonce24 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 24))
	box48 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 48))
	payload := `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`
	encBody := `{"text":"` + longText + `","encrypted":true,"encryptedPayload":` + strconv.Quote(payload) + `}`
	encReq := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages", alice.token, encBody)
	encReq.SetPathValue("id", chat.ID)
	encW := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(encW, encReq)
	if encW.Code != http.StatusCreated {
		t.Fatalf("expected 201 for long ciphertext, got %d: %s", encW.Code, encW.Body.String())
	}
}

func TestEncryptedMessagePayloadValidation(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	bob := registerTestUser(t, h, "bob", "bob@test.local")

	chat := createTestChat(t, h, alice.token, bob.id)

	nonce24 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 24))
	box48 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 48))

	for name, payload := range map[string]string{
		"not json":        `not-json`,
		"wrong version":   `{"v":2,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`,
		"missing nonce":   `{"v":1,"envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`,
		"nonce too short": `{"v":1,"nonce":"` + base64.StdEncoding.EncodeToString([]byte("abc")) + `","envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`,
		"nonce not b64":   `{"v":1,"nonce":"!!!","envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`,
		"no envelopes":    `{"v":1,"nonce":"` + nonce24 + `","envelopes":[]}`,
		"empty keyId":     `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"","box":"` + box48 + `"}]}`,
		"empty box":       `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + bob.id + `","box":""}]}`,
		"box too short":   `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + bob.id + `","box":"` + base64.StdEncoding.EncodeToString([]byte("x")) + `"}]}`,
		"too large":       `{"v":1,"nonce":"` + strings.Repeat("A", maxEncryptedPayloadLen) + `"}`,
	} {
		body := `{"text":"hi","encrypted":true,"encryptedPayload":` + strconv.Quote(payload) + `}`
		req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages", alice.token, body)
		req.SetPathValue("id", chat.ID)
		w := httptest.NewRecorder()
		h.AuthMiddleware(h.SendMessage)(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d: %s", name, w.Code, w.Body.String())
		}
	}

	// A well-formed payload must be accepted.
	valid := `{"v":1,"nonce":"` + nonce24 + `","envelopes":[{"keyId":"` + bob.id + `","box":"` + box48 + `"}]}`
	body := `{"text":"hi","encrypted":true,"encryptedPayload":` + strconv.Quote(valid) + `}`
	req := authReq(http.MethodPost, "/api/chats/"+chat.ID+"/messages", alice.token, body)
	req.SetPathValue("id", chat.ID)
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.SendMessage)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 for valid payload, got %d: %s", w.Code, w.Body.String())
	}
}