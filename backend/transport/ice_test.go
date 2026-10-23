package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"fast_chat/config"
	"fast_chat/internal/turn"
)

// getICE asks the endpoint for the configuration of the user.
func getICE(t *testing.T, api huma.API, token string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/ice", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	return rec
}

func TestICERequiresAuthorization(t *testing.T) {
	api := newTestAPI(newTestMux())
	api.UseMiddleware(AuthMiddleware(newTestStore(t)))
	RegisterICE(api, testAPIConfig())

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/ice", http.NoBody)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestICEReturnsConfiguration(t *testing.T) {
	cfg := testAPIConfig()
	cfg.ICE = config.ICEConfig{
		STUN: []string{"stun:stun.example.test:19302"},
		TURN: []config.TURNServer{{
			URLs:       []string{"turn:turn.example.test:3478"},
			Username:   "fastchat",
			Credential: "secret",
		}},
	}

	api := newTestAPI(newTestMux())
	st := newTestStore(t)
	api.UseMiddleware(AuthMiddleware(st))
	RegisterICE(api, cfg)

	user := createTestUser(t, st)
	rec := getICE(t, api, user.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var out config.ICEConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if len(out.STUN) != 1 || out.STUN[0] != "stun:stun.example.test:19302" {
		t.Errorf("stun = %v", out.STUN)
	}

	if len(out.TURN) != 1 || out.TURN[0].Username != "fastchat" {
		t.Errorf("turn = %+v", out.TURN)
	}
}

func TestICEIssuesTurnCredentials(t *testing.T) {
	cfg := testAPIConfig()
	cfg.ICE = config.ICEConfig{
		TURN: []config.TURNServer{{
			URLs:   []string{"turn:turn.example.test:3478"},
			Secret: "s3cret",
		}},
	}

	api := newTestAPI(newTestMux())
	st := newTestStore(t)
	api.UseMiddleware(AuthMiddleware(st))
	RegisterICE(api, cfg)

	user := createTestUser(t, st)
	before := time.Now()
	rec := getICE(t, api, user.Token)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// The secret of the relay is the key of every credential: it must never
	// reach a client.
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Fatalf("the response carries the secret: %s", rec.Body.String())
	}

	var out config.ICEConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}

	if len(out.TURN) != 1 || len(out.TURN[0].URLs) != 1 {
		t.Fatalf("turn = %+v", out.TURN)
	}

	stamp, name, ok := strings.Cut(out.TURN[0].Username, ":")
	if !ok || name != user.ID {
		t.Fatalf("username = %q, want the expiry and %q", out.TURN[0].Username, user.ID)
	}

	expires, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		t.Fatalf("expiry %q is not a number: %v", stamp, err)
	}

	want := before.Add(turn.CredentialTTL).Unix()
	if expires < want || expires > want+5 {
		t.Fatalf("expiry = %d, want %d", expires, want)
	}

	if out.TURN[0].Credential == "" {
		t.Fatal("the credential is empty")
	}
}
