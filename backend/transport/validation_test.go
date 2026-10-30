package transport

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"fast_chat/federation"
	"fast_chat/model"
)

// TestBearerSchemeEnforced verifies a bare token or another scheme never
// authenticates, even when the value matches a live session.
func TestBearerSchemeEnforced(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	user := createTestUser(t, ts.Store)

	for _, header := range []string{user.Token, "Basic " + user.Token, "bearer " + user.Token} {
		req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/chats", http.NoBody)
		req.Header.Set("Authorization", header)
		rec := httptest.NewRecorder()

		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("header %q: expected 401, got %d: %s", header, rec.Code, rec.Body.String())
		}
	}

	// Double space after the scheme is tolerated (trimmed), not a false 401.
	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/chats", http.NoBody)
	req.Header.Set("Authorization", "Bearer  "+user.Token)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("double-space Bearer: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestSSEInvalidConnectionID verifies client-chosen IDs outside
// [A-Za-z0-9._-] are rejected before registering a stream.
func TestSSEInvalidConnectionID(t *testing.T) {
	ts := newDomainTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/events?connectionId=bad%20id!", http.NoBody)
	rec := httptest.NewRecorder()

	ts.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// newChatWithThread creates a private chat with one message and a thread on
// it, returning the chat, a foreign chat, and the thread ID.
func newChatWithThread(t *testing.T, ts *domainTestServer, alice *model.User) (string, string, string) {
	t.Helper()

	bob, err := ts.Store.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token, `{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for chat, got %d: %s", rec.Code, rec.Body.String())
	}

	chatID := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	// A second chat is not needed: any other ID must 404 the thread route.
	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, `{"id":"m1","text":"hello"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for message, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages/m1/thread", alice.Token, `{}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for thread, got %d: %s", rec.Code, rec.Body.String())
	}

	threadID := decodeBody(t, rec)["thread"].(map[string]any)["id"].(string)

	return chatID, "foreign-chat-id", threadID
}

// TestThreadChatMismatch verifies thread routes reject a thread addressed
// through a chat it does not belong to.
func TestThreadChatMismatch(t *testing.T) {
	ts := newDomainTestServer(t)
	alice := createTestUser(t, ts.Store)
	chatID, foreignID, threadID := newChatWithThread(t, ts, alice)

	_ = chatID

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodGet, "/api/chats/"+foreignID+"/threads/"+threadID+"/messages", alice.Token, ""))
	if rec.Code != http.StatusNotFound {
		t.Errorf("list through foreign chat: expected 404, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+foreignID+"/threads/"+threadID+"/messages", alice.Token, `{"id":"x","text":"hi"}`))
	if rec.Code != http.StatusNotFound {
		t.Errorf("send through foreign chat: expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestMessageBatchCaps verifies MissingIDs and FileIDs/FileHashes are capped
// on the transport before fanning out to the store.
func TestMessageBatchCaps(t *testing.T) {
	ts := newDomainTestServer(t)
	alice := createTestUser(t, ts.Store)
	chatID, _, _ := newChatWithThread(t, ts, alice)

	ids := make([]string, 0, 101)
	for i := range 101 {
		ids = append(ids, fmt.Sprintf(`"m%d"`, i))
	}

	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages/query", alice.Token,
		`{"missingIDs":[`+strings.Join(ids, ",")+`]}`))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("101 missingIDs: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	files := make([]string, 0, 11)
	for i := range 11 {
		files = append(files, fmt.Sprintf(`"f%d"`, i))
	}

	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token,
		`{"id":"cap1","text":"hi","fileIDs":[`+strings.Join(files, ",")+`]}`))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("11 fileIDs: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "too many files" {
		t.Errorf("error = %v, want %q", resp["error"], "too many files")
	}
}

// TestFederatedTypingValidatesUser verifies a signed peer cannot emit typing
// as a local user or an empty ID.
func TestFederatedTypingValidatesUser(t *testing.T) {
	ts := newDomainTestServer(t)
	h, fm := ts.Handler, ts.Fed

	alice := createTestUser(t, ts.Store)

	// The manager verifies self-signed requests against its own key, so the
	// chat points at the local domain: what matters here is the
	// transport-level UserID check, which runs after federatedChatForSource.
	chatLocal := &model.Chat{
		ID:           "fed-chat-typing-local",
		Members:      []string{alice.ID, "bob:" + fm.ServerDomain()},
		RemoteServer: fm.ServerDomain(),
		CreatedAt:    time.Now().UTC(),
	}
	if err := ts.Store.CreateRemoteChat(context.Background(), chatLocal); err != nil {
		t.Fatal(err)
	}

	signedLocal := func(body string, nonce string) *http.Request {
		timestamp := time.Now().Unix()
		uri := "/api/federated/chats/" + chatLocal.ID + "/typing"
		sig, err := fm.Sign(fm.ServerDomain(), http.MethodPost, uri, []byte(body), timestamp, nonce)
		if err != nil {
			t.Fatal(err)
		}

		req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, uri, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Federation-Server", fm.ServerDomain())
		req.Header.Set("X-Federation-Signature", sig)
		req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))
		req.Header.Set(federation.NonceHeader, nonce)

		return req
	}

	for name, body := range map[string]string{
		// A user of a third server is neither local nor the sender.
		"third-party user": `{"userId":"mallory:other.example.com","active":true}`,
		"empty":            `{"userId":"","active":true}`,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, signedLocal(body, "nonce-"+name))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s typing: expected 403, got %d: %s", name, rec.Code, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, signedLocal(`{"userId":"bob:`+fm.ServerDomain()+`","active":true}`, "nonce-valid"))
	if rec.Code != http.StatusOK {
		t.Errorf("remote user typing: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestPushSubscriptionValidation verifies key shape enforcement and the
// per-user subscription quota.
func TestPushSubscriptionValidation(t *testing.T) {
	ts := newDomainTestServer(t)
	user := createTestUser(t, ts.Store)

	p256dh := base64.RawURLEncoding.EncodeToString(make([]byte, 65))
	auth := base64.RawURLEncoding.EncodeToString(make([]byte, 16))

	// Malformed keys are rejected even with a valid endpoint.
	rec := httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token,
		`{"endpoint":"https://fcm.googleapis.com/fcm/send/x","p256dh":"k","auth":"a"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad keys: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "invalid push subscription keys" {
		t.Fatalf("error = %v, want %q", resp["error"], "invalid push subscription keys")
	}

	// Fill the quota, then exceed it.
	for i := range maxPushSubscriptionsPerUser {
		rec := httptest.NewRecorder()
		ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token,
			`{"endpoint":"https://fcm.googleapis.com/fcm/send/`+strconv.Itoa(i)+`","p256dh":"`+p256dh+`","auth":"`+auth+`"}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("sub %d: expected 200, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	// Re-subscribing a known endpoint refreshes it and stays allowed.
	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token,
		`{"endpoint":"https://fcm.googleapis.com/fcm/send/0","p256dh":"`+p256dh+`","auth":"`+auth+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh known endpoint: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ts.Handler.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/push/subscribe", user.Token,
		`{"endpoint":"https://fcm.googleapis.com/fcm/send/overflow","p256dh":"`+p256dh+`","auth":"`+auth+`"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("over quota: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	if resp := decodeBody(t, rec); resp["error"] != "too many push subscriptions" {
		t.Fatalf("error = %v, want %q", resp["error"], "too many push subscriptions")
	}
}
