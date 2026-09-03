package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/store"
)

func newAuthTestServer(t *testing.T, cfg *APIConfig) (huma.API, *store.Store) { //nolint:ireturn // huma.API is the required interface
	t.Helper()

	st := newTestStore(t)
	hub := newTestHub()
	svc := newTestService(st, hub)
	api := newTestAPI(newTestMux())
	api.UseMiddleware(AuthMiddleware(st))
	RegisterAuth(api, svc, st, hub, cfg)

	return api, st
}

func TestSendCodeValidation(t *testing.T) {
	api, _ := newAuthTestServer(t, &APIConfig{DebugEmail: true})

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/auth/send-code", strings.NewReader(`{"email":"not-an-email"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	// Input validation lives in the service layer (legacy parity): an
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
	// with the legacy {"error": "..."} shape.
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
