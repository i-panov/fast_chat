package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"fast_chat/config"
)

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

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/ice", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+user.Token)
	rec := httptest.NewRecorder()

	api.Adapter().ServeHTTP(rec, req)

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
