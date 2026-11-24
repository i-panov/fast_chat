package transport

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"fast_chat/model"
	"fast_chat/service"
	"fast_chat/store"
)

func newAdminTransport(t *testing.T) (*Transport, *store.Store) {
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := service.New(st, testAPIConfig(), hub, nil)

	return New(&Deps{Hub: hub, Store: st, Svc: svc, Cfg: testAPIConfig()}), st
}

func adminRequest(t *testing.T, tr *Transport, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequestWithContext(context.Background(), method, path, http.NoBody)
	if body != "" {
		req = httptest.NewRequestWithContext(context.Background(), method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	tr.Handler().ServeHTTP(rec, req)

	return rec
}

func TestAdminTransportChecksTheRole(t *testing.T) {
	tr, st := newAdminTransport(t)
	alice := createTestUser(t, st)
	bob, err := st.CreateUser(context.Background(), "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	rec := adminRequest(t, tr, http.MethodGet, "/api/admin/users", alice.Token, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin list = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	if err := st.AdminSetUserAdmin(context.Background(), alice.ID, true, nil); err != nil {
		t.Fatal(err)
	}
	rec = adminRequest(t, tr, http.MethodGet, "/api/admin/users", alice.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list = %d: %s", rec.Code, rec.Body.String())
	}

	var page struct {
		Users []model.User `json:"users"`
		Total int64        `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Users) != 2 {
		t.Fatalf("page = %+v", page)
	}

	// Banning bob revokes his session, so his very next request is rejected.
	// An empty chat must serialize its message page as [], not null: the
	// admin screen maps the list and null would crash it.
	chat, err := st.CreateChat(context.Background(), alice.ID, bob.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	rec = adminRequest(t, tr, http.MethodGet, "/api/admin/chats/"+chat.ID+"/messages", alice.Token, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"messages":[]`) {
		t.Fatalf("empty messages = %d: %s", rec.Code, rec.Body.String())
	}

	rec = adminRequest(t, tr, http.MethodPatch, "/api/admin/users/"+bob.ID, alice.Token, `{"banned":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("ban = %d: %s", rec.Code, rec.Body.String())
	}
	// The ban revokes the session in the same transaction, so the token is
	// simply unknown. The banned check in the middleware covers the narrow
	// race where a request already passed the token lookup.
	rec = adminRequest(t, tr, http.MethodGet, "/api/sessions", bob.Token, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("banned session = %d, want 401", rec.Code)
	}

	// A session created after the ban (or one racing its revocation) must
	// not bind an SSE stream: that path reads the token without the REST
	// middleware.
	_, bannedToken, err := st.CreateSession(context.Background(), bob.ID, "device-banned", "Banned", "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	rec = adminRequest(t, tr, http.MethodPost, "/api/auth/sse-auth", "",
		fmt.Sprintf(`{"connectionId":"conn-banned","token":%q}`, bannedToken))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("banned sse-auth = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	// Store and service define their own sentinels: the transport must see
	// the service one, otherwise an unknown target is a 500.
	rec = adminRequest(t, tr, http.MethodPatch, "/api/admin/users/missing:test", alice.Token, `{"banned":true}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown user PATCH = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	rec = adminRequest(t, tr, http.MethodGet, "/api/admin/audit", alice.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("audit = %d: %s", rec.Code, rec.Body.String())
	}
}
