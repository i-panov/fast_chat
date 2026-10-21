package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/calls"
	"fast_chat/store"
)

func newCallsTestServer(t *testing.T) (huma.API, *store.Store, string) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	svc.SetCallManager(calls.NewManager(func(string) bool { return true }))

	api := newTestAPI(newTestMux())
	api.UseMiddleware(AuthMiddleware(st))
	RegisterCalls(api, svc)

	user := createTestUser(t, st)

	return api, st, user.Token
}

// createCallChat creates the two users and a private chat in the store.
func createCallChat(t *testing.T, st *store.Store, alice, bob string) string {
	t.Helper()

	ctx := context.Background()

	for _, userID := range []string{alice, bob} {
		if _, ok := st.GetUserByID(ctx, userID); ok {
			continue
		}

		nick, _, _ := strings.Cut(userID, ":")
		if _, err := st.CreateUser(ctx, nick+"@test.local", nick, "localhost:8080", time.Hour); err != nil {
			t.Fatal(err)
		}
	}

	chat, err := st.CreateChat(ctx, alice, bob, "")
	if err != nil {
		t.Fatal(err)
	}

	return chat.ID
}

func TestStartCallRequiresAuthorization(t *testing.T) {
	api, _, _ := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"c1","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartCallInUnknownChatAnswers404(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"missing","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartCallWithEmptyOfferAnswers400(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"`+chatID+`","offer":""}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestStartCallAnswers201(t *testing.T) {
	api, st, token := newCallsTestServer(t)

	chatID := createCallChat(t, st, "alice:localhost:8080", "bob:localhost:8080")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls", strings.NewReader(`{"chatId":"`+chatID+`","offer":"v=0"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var out struct {
		CallID string `json:"callId"`
		State  string `json:"state"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if out.CallID == "" || out.State != "ringing" {
		t.Fatalf("unexpected body: %+v", out)
	}
}

func TestCurrentCallAnswers404WithoutACall(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/calls/current", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHangupOnUnknownCallAnswers404(t *testing.T) {
	api, _, token := newCallsTestServer(t)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/calls/missing/hangup", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}
