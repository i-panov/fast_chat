package transport

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// An idempotent retry of an already stored message is not a creation: the
// outbox must be told that with 200, not with 201.
func TestSendMessageRetryAnswersOK(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	alice := createTestUser(t, ts.Store)

	bob, err := ts.Store.CreateUser(t.Context(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token,
		`{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create chat: %d: %s", rec.Code, rec.Body.String())
	}

	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	const body = `{"id":"retry-1","text":"hello"}`

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first send: %d: %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("retry: status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// The client message id is bounded before it becomes a primary key.
func TestSendMessageRejectsAnOverlongID(t *testing.T) {
	ts := newDomainTestServer(t)
	h := ts.Handler
	alice := createTestUser(t, ts.Store)

	bob, err := ts.Store.CreateUser(t.Context(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats", alice.Token,
		`{"type":"private","withUserId":"`+bob.ID+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create chat: %d", rec.Code)
	}
	chatID, _ := decodeBody(t, rec)["chat"].(map[string]any)["id"].(string)

	long := make([]byte, 200)
	for i := range long {
		long[i] = 'x'
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bearerReq(t, http.MethodPost, "/api/chats/"+chatID+"/messages", alice.Token,
		`{"id":"`+string(long)+`","text":"hello"}`))
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("over-long id: status = %d, want 400/422: %s", rec.Code, rec.Body.String())
	}
}
