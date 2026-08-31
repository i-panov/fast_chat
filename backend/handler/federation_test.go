package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFederatedURL(t *testing.T) {
	h := newTestHandler(t)

	cases := []struct {
		remote string
		path   string
		want   string
	}{
		{"remote.test", "/api/federated/x", "http://remote.test/api/federated/x"},
		{"remote.test:9090", "/m", "http://remote.test:9090/m"},
	}

	for _, tc := range cases {
		if got := h.federatedURL(tc.remote, tc.path); got != tc.want {
			t.Errorf("federatedURL(%q, %q) = %q, want %q", tc.remote, tc.path, got, tc.want)
		}
	}
}

func TestIsValidRemoteDomain(t *testing.T) {
	cases := []struct {
		domain string
		want   bool
	}{
		{"example.com", true},
		{"remote.test:9090", true},
		{"localhost", false},
		{"localhost.", false},
		{"127.0.0.1", false},       // loopback
		{"::1", false},             // loopback IPv6
		{"10.0.0.2", false},        // private
		{"172.16.0.3", false},      // private
		{"192.168.1.4", false},     // private
		{"169.254.169.254", false}, // link-local (incl. metadata service)
		{"0.0.0.0", false},         // unspecified
		{"203.0.113.7", true},      // public
	}

	for _, tc := range cases {
		if got := isValidRemoteDomain(tc.domain); got != tc.want {
			t.Errorf("isValidRemoteDomain(%q) = %v, want %v", tc.domain, got, tc.want)
		}
	}
}

func TestRemoteServerFromIDRejectsUnsafeDomains(t *testing.T) {
	cases := []struct {
		id   string
		want string
	}{
		{"alice:example.com", "example.com"},
		{"alice:example.com:9090", "example.com:9090"},
		{"alice:127.0.0.1", ""},          // loopback
		{"alice:10.0.0.5", ""},           // private
		{"alice:localhost:8080.", ""},    // invalid: trailing dot with port
		{"alice:evil.com/foo", ""},       // path injection
		{"alice:evil.com@other.com", ""}, // userinfo injection
		{"alice:evil.com#frag", ""},      // fragment injection
		{"alice:evil.com?x=1", ""},       // query injection
	}

	for _, tc := range cases {
		if got := remoteServerFromID(tc.id); got != tc.want {
			t.Errorf("remoteServerFromID(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}

func TestDoFederatedRequestSuccess(t *testing.T) {
	h := newTestHandler(t)

	var gotHeaders http.Header
	var gotBody []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header.Clone()
		gotBody, _ = json.Marshal(map[string]any{"reply": "ok"})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(gotBody)
	}))
	defer srv.Close()

	// The local server is loopback; use its own client instead of the
	// SSRF-safe dialer for the test.
	h.fedClient = srv.Client()

	body, err := h.doFederatedRequest(context.Background(), http.MethodPost, srv.URL+"/api/federated/x", map[string]any{"hello": "world"})
	if err != nil {
		t.Fatalf("doFederatedRequest: %v", err)
	}

	if string(body) != string(gotBody) {
		t.Errorf("response body mismatch: got %s, want %s", body, gotBody)
	}

	if gotHeaders.Get("X-Federation-Server") != h.cfg.Server.Domain {
		t.Errorf("X-Federation-Server = %q, want %q", gotHeaders.Get("X-Federation-Server"), h.cfg.Server.Domain)
	}

	if gotHeaders.Get("X-Federation-Signature") == "" {
		t.Error("X-Federation-Signature header is missing")
	}

	if gotHeaders.Get("X-Federation-Timestamp") == "" {
		t.Error("X-Federation-Timestamp header is missing")
	}

	if gotHeaders.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotHeaders.Get("Content-Type"))
	}
}

func TestDoFederatedRequestReturnsErrorBody(t *testing.T) {
	h := newTestHandler(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}))
	defer srv.Close()

	h.fedClient = srv.Client()

	_, err := h.doFederatedRequest(context.Background(), http.MethodPost, srv.URL+"/x", map[string]any{"a": 1})
	if !errors.Is(err, errFederatedStatus) {
		t.Fatalf("expected errFederatedStatus, got %v", err)
	}

	if !strings.Contains(err.Error(), "nope") {
		t.Errorf("error should surface the upstream body: %v", err)
	}
}

func TestDoFederatedRequestRejectsMalformedURL(t *testing.T) {
	h := newTestHandler(t)

	_, err := h.doFederatedRequest(context.Background(), http.MethodPost, "http://[::1", map[string]any{"a": 1})
	if err == nil {
		// Note: url.Parse on this input actually succeeds in net/url for
		// "http://[::1"; make sure we never get a 200 via the network.
		t.Fatal("expected an error for a malformed federated URL")
	}
}

func TestDoFederatedRequestNilBody(t *testing.T) {
	h := newTestHandler(t)

	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	h.fedClient = srv.Client()

	body, err := h.doFederatedRequest(context.Background(), http.MethodDelete, srv.URL+"/x", nil)
	if err != nil {
		t.Fatalf("doFederatedRequest: %v", err)
	}

	if gotBody != "" {
		t.Errorf("expected empty request body for nil payload, got %q", gotBody)
	}

	if string(body) != "ok" {
		t.Errorf("expected body ok, got %q", body)
	}
}

func TestSendFedEmptyRemoteIsNoop(t *testing.T) {
	h := newTestHandler(t)

	// These must not panic and must not attempt any request.
	h.sendFedPost(context.Background(), "", "/x", map[string]any{"a": 1})
	h.sendFedPatch(context.Background(), "", "/x", map[string]any{"a": 1})
	h.sendFedDelete(context.Background(), "", "/x")
}

func TestSSEAuthFlow(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")

	t.Run("valid token with no connection is 404", func(t *testing.T) {
		req := authReq(http.MethodPost, "/api/sse/auth", alice.token, `{"connectionId":"missing","token":"`+alice.token+`"}`)
		w := httptest.NewRecorder()
		h.SSEAuth(w, req)

		if w.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("invalid token is unauthorized", func(t *testing.T) {
		req := authReq(http.MethodPost, "/api/sse/auth", alice.token, `{"connectionId":"c1","token":"bogus"}`)
		w := httptest.NewRecorder()
		h.SSEAuth(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("valid connection authenticates", func(t *testing.T) {
		conn := h.hub.Register("conn-SSEAuthFlow")
		defer h.hub.Unregister("conn-SSEAuthFlow", conn)

		req := authReq(http.MethodPost, "/api/sse/auth", alice.token, `{"connectionId":"conn-SSEAuthFlow","token":"`+alice.token+`"}`)
		w := httptest.NewRecorder()
		h.SSEAuth(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestRefreshToken(t *testing.T) {
	h := newTestHandler(t)
	alice := registerTestUser(t, h, "alice", "alice@test.local")
	oldToken := alice.token

	req := authReq(http.MethodPost, "/api/auth/refresh", alice.token, "")
	w := httptest.NewRecorder()
	h.AuthMiddleware(h.RefreshToken)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if resp.Token == "" || resp.Token == oldToken {
		t.Error("refresh should issue a new non-empty token")
	}

	// Old token must no longer authenticate.
	req2 := authReq(http.MethodGet, "/api/anything", oldToken, "")
	w2 := httptest.NewRecorder()
	h.AuthMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))(w2, req2)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("old token should be rejected after refresh, got %d", w2.Code)
	}
}
