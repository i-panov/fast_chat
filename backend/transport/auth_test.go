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

	"fast_chat/sse"
	"fast_chat/store"
)

func newAuthTestServer(t *testing.T, cfg *APIConfig) (huma.API, *store.Store) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	api, st, _ := newAuthTestServerWithHub(t, cfg)

	return api, st
}

func newAuthTestServerWithHub(t *testing.T, cfg *APIConfig) (huma.API, *store.Store, *sse.Hub) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	api := newTestAPI(newTestMux())
	api.UseMiddleware(AuthMiddleware(st))
	RegisterAuth(api, svc, st, hub, cfg)

	return api, st, hub
}

func TestSendCodeValidation(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{DebugEmail: true})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"not-an-email"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	// Input validation lives in the service layer (pre-migration parity): an
	// unparsable email maps to 400 "invalid email", not Huma's 422.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp["error"] != "invalid email" {
		t.Errorf("error = %v, want %q", resp["error"], "invalid email")
	}
}

func TestSendCodeNormalizesEmail(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{DebugEmail: true})

	// Legacy behavior: whitespace-padded and mixed-case emails are normalized
	// by the service and accepted (no schema-level format rejection).
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"  Alice@Test.Local "}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSendCodeDebugMode(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{DebugEmail: true})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"test@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp["status"] != "sent" {
		t.Errorf("status = %v, want sent", resp["status"])
	}

	if resp["debugCode"] == nil || resp["debugCode"] == "" {
		t.Error("expected debugCode in debug mode")
	}
}

func TestRefreshTokenUnauthorized(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/refresh-token", http.NoBody)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestRefreshTokenSuccess(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})

	user := createTestUser(t, st)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/refresh-token", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+user.Token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp["token"] == nil || resp["token"] == "" {
		t.Errorf("expected a refreshed token, got: %v", resp)
	}
}

func TestErrorResponseLegacyShape(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{})

	// An invalid/nonexistent setup token maps to ErrInvalidSetupToken → 401
	// with the pre-migration {"error": "..."} shape.
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/complete-registration", strings.NewReader(`{"setupToken":"nope","nick":"alice"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}

	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", got)
	}

	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("error body not JSON: %v (body=%q)", err, rec.Body.String())
	}

	if resp["error"] != "invalid setup token" {
		t.Errorf("error field = %q, want %q (body=%q)", resp["error"], "invalid setup token", rec.Body.String())
	}

	// Legacy shape must not include Huma's $schema key.
	if _, has := resp["$schema"]; has {
		t.Errorf("unexpected $schema field in error body: %q", rec.Body.String())
	}
}

// The logout revokes the token on the server: a token that only disappears
// from the browser stays usable until it expires.
func TestLogoutRevokesTheToken(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})

	user := createTestUser(t, st)

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+user.Token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	if _, ok := st.GetUserByToken(context.Background(), user.Token); ok {
		t.Fatal("the token still works after the logout")
	}
}

// sse-auth must bind the connection to the session the token belongs to, not
// merely to the user: closing one device's session must leave the other
// devices alone.
func TestSSEAuthBindsConnectionToSession(t *testing.T) {
	api, st, hub := newAuthTestServerWithHub(t, &APIConfig{})
	t.Cleanup(hub.Close)

	user := createTestUser(t, st)

	session, _, ok := st.GetSessionByToken(context.Background(), user.Token)
	if !ok {
		t.Fatal("test user has no session")
	}

	hub.Register("c1")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/sse-auth",
		strings.NewReader(`{"connectionId":"c1","token":"`+user.Token+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	conn := hub.GetConnection("c1")
	if conn == nil {
		t.Fatal("connection missing after sse-auth")
	}

	conn.Lock()
	sessionID := conn.SessionID
	authorized := conn.Authorized
	conn.Unlock()

	if sessionID != session.ID {
		t.Errorf("connection sessionID = %q, want %q", sessionID, session.ID)
	}
	if !authorized {
		t.Error("connection must be authorized after sse-auth")
	}
	if !st.IsSessionOnline(session.ID) {
		t.Error("session must be online after sse-auth")
	}
	if !st.IsOnline(user.ID) {
		t.Error("user must be online after sse-auth")
	}
}

// A revoked session must not authenticate a new SSE stream, even when the
// user's other sessions are alive.
func TestSSEAuthRejectsRevokedSession(t *testing.T) {
	api, st, hub := newAuthTestServerWithHub(t, &APIConfig{})
	t.Cleanup(hub.Close)

	user := createTestUser(t, st)

	session, _, ok := st.GetSessionByToken(context.Background(), user.Token)
	if !ok {
		t.Fatal("test user has no session")
	}

	if err := st.RevokeSession(context.Background(), user.ID, session.ID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}

	hub.Register("c1")

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/sse-auth",
		strings.NewReader(`{"connectionId":"c1","token":"`+user.Token+`"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}

	conn := hub.GetConnection("c1")
	if conn == nil {
		t.Fatal("connection missing after rejected sse-auth")
	}

	conn.Lock()
	authorized := conn.Authorized
	conn.Unlock()

	if authorized {
		t.Error("revoked session must not authorize the connection")
	}
	if st.IsSessionOnline(session.ID) {
		t.Error("revoked session must not be marked online")
	}
}

// The frontend retries sse-auth on the same connection. Repeating the auth for
// the same session must not increment presence again: otherwise the single
// disconnect never takes the session offline.
func TestSSEAuthIsIdempotentForPresence(t *testing.T) {
	api, st, hub := newAuthTestServerWithHub(t, &APIConfig{})
	t.Cleanup(hub.Close)
	ctx := context.Background()

	user := createTestUser(t, st)
	session, _, ok := st.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("test user has no session")
	}

	hub.Register("c1")

	auth := func() *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/auth/sse-auth",
			strings.NewReader(`{"connectionId":"c1","token":"`+user.Token+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		api.Adapter().ServeHTTP(rec, req)

		return rec
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if rec := auth(); rec.Code != http.StatusOK {
			t.Fatalf("sse-auth attempt %d = %d: %s", attempt, rec.Code, rec.Body.String())
		}
	}

	// Presence was counted once, so removing the only connection must take
	// the user and the session offline.
	if !st.RemoveConnectionForSession(user.ID, session.ID) {
		t.Fatal("one connection removal must be the last one for the user")
	}
	if st.IsSessionOnline(session.ID) {
		t.Error("session must be offline after the only connection is removed")
	}
	if st.IsOnline(user.ID) {
		t.Error("user must be offline after the only connection is removed")
	}
}

// A connection already bound to one session must not be rebound to another:
// the presence of the first binding would leak.
func TestSSEAuthRejectsRebindingToAnotherSession(t *testing.T) {
	api, st, hub := newAuthTestServerWithHub(t, &APIConfig{})
	t.Cleanup(hub.Close)
	ctx := context.Background()

	user := createTestUser(t, st)
	first, _, ok := st.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("test user has no session")
	}

	second, secondToken, err := st.CreateSession(ctx, user.ID, "dev-2", "Phone", "ua", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	hub.Register("c1")

	auth := func(token string) int {
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/auth/sse-auth",
			strings.NewReader(`{"connectionId":"c1","token":"`+token+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		api.Adapter().ServeHTTP(rec, req)

		return rec.Code
	}

	if code := auth(user.Token); code != http.StatusOK {
		t.Fatalf("first sse-auth = %d, want 200", code)
	}
	if code := auth(secondToken); code != http.StatusConflict {
		t.Fatalf("rebinding sse-auth = %d, want 409", code)
	}

	conn := hub.GetConnection("c1")
	if conn == nil {
		t.Fatal("connection missing")
	}
	conn.Lock()
	sessionID := conn.SessionID
	conn.Unlock()
	if sessionID != first.ID {
		t.Fatalf("connection sessionID = %q, want the first session %q", sessionID, first.ID)
	}

	if !st.RemoveConnectionForSession(user.ID, first.ID) {
		t.Fatal("presence must still belong to exactly the first session")
	}
	if st.IsSessionOnline(second.ID) {
		t.Error("the rejected rebind must not mark the second session online")
	}
}
