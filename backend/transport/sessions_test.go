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

	"fast_chat/store"
)

// loginTestDevice stores a fresh verification code (the code store deletes it
// on success) and logs the device in through the verify-code API.
func loginTestDevice(t *testing.T, api huma.API, st *store.Store, email, deviceID string) string {
	t.Helper()

	st.Codes().StoreCode(email, "123456", time.Minute)

	body := `{"email":"` + email + `","code":"123456","deviceId":"` + deviceID + `","deviceName":"` + deviceID + `"}`
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/verify-code", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login %s: %d %s", deviceID, rec.Code, rec.Body.String())
	}

	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.Token == "" {
		t.Fatalf("login %s returned no token: %s", deviceID, rec.Body.String())
	}

	return resp.Token
}

// authedRequest sends a request with the given bearer token.
func authedRequest(t *testing.T, api huma.API, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()

	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	req := httptest.NewRequestWithContext(context.Background(), method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}

	req.Header.Set("Authorization", "Bearer "+token)

	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	return rec
}

func TestLoginOnSecondDeviceKeepsFirstToken(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})
	ctx := context.Background()
	user := createTestUser(t, st)

	first := loginTestDevice(t, api, st, user.Email, "dev-1")
	second := loginTestDevice(t, api, st, user.Email, "dev-2")

	if first == second {
		t.Fatal("tokens must differ")
	}

	for _, token := range []string{first, second} {
		if _, _, ok := st.GetSessionByToken(ctx, token); !ok {
			t.Fatalf("token %q must be valid", token)
		}
	}
}

func TestListSessionsMarksCurrent(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})
	user := createTestUser(t, st)

	rec := authedRequest(t, api, http.MethodGet, "/api/sessions", user.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		CurrentSessionID string `json:"currentSessionId"`
		Sessions         []struct {
			ID      string `json:"id"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.CurrentSessionID == "" || len(resp.Sessions) != 1 || !resp.Sessions[0].Current {
		t.Fatalf("response = %+v", resp)
	}
}

func TestListSessionsRequiresAuth(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/sessions", nil)
	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
}

func TestLogoutRevokesOnlyCurrentSession(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()
	user := createTestUser(t, st)

	deviceToken := loginTestDevice(t, api, st, user.Email, "dev-1")

	rec := authedRequest(t, api, http.MethodPost, "/api/auth/logout", deviceToken, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	if _, _, ok := st.GetSessionByToken(ctx, deviceToken); ok {
		t.Error("the logged-out device token must stop working")
	}

	if _, _, ok := st.GetSessionByToken(ctx, user.Token); !ok {
		t.Error("logout must keep the other device of the account")
	}
}

func TestLogoutAllRevokesEverySession(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()
	user := createTestUser(t, st)

	deviceToken := loginTestDevice(t, api, st, user.Email, "dev-1")

	rec := authedRequest(t, api, http.MethodPost, "/api/auth/logout-all", deviceToken, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	for _, token := range []string{user.Token, deviceToken} {
		if _, _, ok := st.GetSessionByToken(ctx, token); ok {
			t.Errorf("token %q must be revoked by logout-all", token)
		}
	}
}

func TestRefreshTokenRotatesOnlyCurrentSession(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()
	user := createTestUser(t, st)

	deviceToken := loginTestDevice(t, api, st, user.Email, "dev-1")
	deviceSession, _, ok := st.GetSessionByToken(ctx, deviceToken)
	if !ok {
		t.Fatal("device session missing")
	}

	rec := authedRequest(t, api, http.MethodPost, "/api/auth/refresh-token", deviceToken, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var resp struct {
		Token     string `json:"token"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if resp.Token == "" || resp.Token == deviceToken {
		t.Fatalf("expected a new token, got %+v", resp)
	}

	if resp.SessionID != deviceSession.ID {
		t.Errorf("sessionId = %q, want %q", resp.SessionID, deviceSession.ID)
	}

	if _, _, ok := st.GetSessionByToken(ctx, deviceToken); ok {
		t.Error("the old token must stop working after refresh")
	}

	if _, _, ok := st.GetSessionByToken(ctx, resp.Token); !ok {
		t.Error("the refreshed token must work")
	}

	if _, _, ok := st.GetSessionByToken(ctx, user.Token); !ok {
		t.Error("refresh must not touch the other device")
	}
}

func TestRevokeSessionRevokesAnotherDevice(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()
	user := createTestUser(t, st)

	legacySession, _, ok := st.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("legacy session missing")
	}

	deviceToken := loginTestDevice(t, api, st, user.Email, "dev-1")

	rec := authedRequest(t, api, http.MethodDelete, "/api/sessions/"+legacySession.ID, deviceToken, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	if _, _, ok := st.GetSessionByToken(ctx, user.Token); ok {
		t.Error("the revoked device token must stop working")
	}

	if _, _, ok := st.GetSessionByToken(ctx, deviceToken); !ok {
		t.Error("the requesting device must keep its session")
	}
}

func TestRevokeSessionNotFound(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	user := createTestUser(t, st)

	rec := authedRequest(t, api, http.MethodDelete, "/api/sessions/does-not-exist", user.Token, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}
}

// The registration flow must return the session it created so the client can
// identify its own device right away.
func TestCompleteRegistrationReturnsSession(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{DebugEmail: true})
	ctx := context.Background()

	st.Codes().StoreCode("bob@test.local", "123456", time.Minute)

	verifyBody := `{"email":"bob@test.local","code":"123456"}`
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/auth/verify-code", strings.NewReader(verifyBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("verify-code: %d %s", rec.Code, rec.Body.String())
	}

	var verified struct {
		SetupToken string `json:"setupToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &verified); err != nil {
		t.Fatal(err)
	}

	regBody := `{"setupToken":"` + verified.SetupToken + `","nick":"bob","deviceId":"dev-1","deviceName":"Chrome"}`
	req = httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/auth/complete-registration", strings.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("complete-registration: %d %s", rec.Code, rec.Body.String())
	}

	var registered struct {
		Token     string `json:"token"`
		SessionID string `json:"sessionId"`
		DeviceID  string `json:"deviceId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &registered); err != nil {
		t.Fatal(err)
	}

	if registered.SessionID == "" || registered.DeviceID != "dev-1" {
		t.Fatalf("registration response = %+v", registered)
	}

	session, _, ok := st.GetSessionByToken(ctx, registered.Token)
	if !ok || session.ID != registered.SessionID {
		t.Fatalf("registration token does not authenticate: %+v", session)
	}
}

// Revoking must be scoped to the authenticated user: one account cannot log
// another account's device out even when it knows the session id.
func TestRevokeSessionOfAnotherUserIsNotFound(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()

	alice := createTestUser(t, st)
	bob, err := st.CreateUser(ctx, "bob@test.local", "bob", "localhost:8080", time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	bobSession, _, ok := st.GetSessionByToken(ctx, bob.Token)
	if !ok {
		t.Fatal("bob has no session")
	}

	rec := authedRequest(t, api, http.MethodDelete, "/api/sessions/"+bobSession.ID, alice.Token, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body.String())
	}

	if _, _, ok := st.GetSessionByToken(ctx, bob.Token); !ok {
		t.Fatal("another user's revoke must not touch bob's session")
	}
}

// Revoking the caller's own session is a logout: the device list must reject
// it so the response is not lost with the session.
func TestRevokeCurrentSessionRejected(t *testing.T) {
	api, st := newAuthTestServer(t, &APIConfig{})
	ctx := context.Background()
	user := createTestUser(t, st)

	session, _, ok := st.GetSessionByToken(ctx, user.Token)
	if !ok {
		t.Fatal("test user has no session")
	}

	rec := authedRequest(t, api, http.MethodDelete, "/api/sessions/"+session.ID, user.Token, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}

	if _, _, ok := st.GetSessionByToken(ctx, user.Token); !ok {
		t.Error("the current session must survive the rejected revoke")
	}
}
