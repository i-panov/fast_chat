package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postJSON(h *Handler, handler func(http.ResponseWriter, *http.Request), token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler(w, req)
	return w
}

func decodeMap(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode: %v (body: %s)", err, w.Body.String())
	}
	return m
}

func TestSendCode(t *testing.T) {
	t.Run("valid email returns code in debug mode", func(t *testing.T) {
		h := newTestHandler(t)
		w := postJSON(h, h.SendCode, "", `{"email":"  Alice@Test.Local "}`)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		resp := decodeMap(t, w)
		if resp["status"] != "sent" {
			t.Errorf("status = %v, want sent", resp["status"])
		}

		code, _ := resp["debugCode"].(string)
		if len(code) != 6 {
			t.Errorf("debugCode = %q, want 6 digits", code)
		}

		// The stored code must be verifiable right away (single source of truth).
		if !h.store.Codes().VerifyCode("alice@test.local", code) {
			t.Error("stored email should be normalized and the code verifiable")
		}
	})

	t.Run("invalid email", func(t *testing.T) {
		h := newTestHandler(t)
		w := postJSON(h, h.SendCode, "", `{"email":"not-an-email"}`)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("bad body", func(t *testing.T) {
		h := newTestHandler(t)
		w := postJSON(h, h.SendCode, "", `{"email":`)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("non-allowed email is forbidden", func(t *testing.T) {
		h := newTestHandler(t)
		h.cfg.Email.AllowedEmails = []string{"allowed@test.local"}

		w := postJSON(h, h.SendCode, "", `{"email":"other@test.local"}`)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestVerifyCodeFlow(t *testing.T) {
	t.Run("new user gets setup token", func(t *testing.T) {
		h := newTestHandler(t)

		send := postJSON(h, h.SendCode, "", `{"email":"new@test.local"}`)
		code := decodeMap(t, send)["debugCode"].(string)

		w := postJSON(h, h.VerifyCode, "", `{"email":"new@test.local","code":"`+code+`"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		resp := decodeMap(t, w)
		if resp["isNew"] != true {
			t.Errorf("isNew = %v, want true", resp["isNew"])
		}
		if resp["setupToken"] == "" {
			t.Error("expected non-empty setupToken")
		}
	})

	t.Run("wrong code is unauthorized", func(t *testing.T) {
		h := newTestHandler(t)
		postJSON(h, h.SendCode, "", `{"email":"new@test.local"}`)

		w := postJSON(h, h.VerifyCode, "", `{"email":"new@test.local","code":"000000"}`)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})
}

func TestCompleteRegistration(t *testing.T) {
	newUser := func(t *testing.T, h *Handler) string {
		t.Helper()
		send := postJSON(h, h.SendCode, "", `{"email":"alice@test.local"}`)
		code := decodeMap(t, send)["debugCode"].(string)
		verify := postJSON(h, h.VerifyCode, "", `{"email":"alice@test.local","code":"`+code+`"}`)
		return decodeMap(t, verify)["setupToken"].(string)
	}

	t.Run("creates user with token", func(t *testing.T) {
		h := newTestHandler(t)
		setup := newUser(t, h)

		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"`+setup+`","nick":"alice"}`)
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}

		resp := decodeMap(t, w)
		if resp["token"] == "" {
			t.Error("expected a token")
		}
		user := resp["user"].(map[string]any)
		if user["nick"] != "alice" {
			t.Errorf("nick = %v, want alice", user["nick"])
		}
	})

	t.Run("empty nick", func(t *testing.T) {
		h := newTestHandler(t)
		setup := newUser(t, h)

		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"`+setup+`","nick":"  "}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", w.Code)
		}
	})

	t.Run("nick too long", func(t *testing.T) {
		h := newTestHandler(t)
		setup := newUser(t, h)

		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"`+setup+`","nick":"`+strings.Repeat("a", 21)+`"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for 21-run nick, got %d", w.Code)
		}
	})

	t.Run("nick with colon", func(t *testing.T) {
		h := newTestHandler(t)
		setup := newUser(t, h)

		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"`+setup+`","nick":"a:b"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for colon nick, got %d", w.Code)
		}
	})

	t.Run("invalid setup token", func(t *testing.T) {
		h := newTestHandler(t)
		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"bogus","nick":"carol"}`)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("nickname already taken", func(t *testing.T) {
		h := newTestHandler(t)
		registerTestUser(t, h, "dave", "dave@test.local")

		setup := newUser(t, h)
		w := postJSON(h, h.CompleteRegistration, "", `{"setupToken":"`+setup+`","nick":"dave"}`)
		if w.Code != http.StatusConflict {
			t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("existing user logs in again (isNew=false)", func(t *testing.T) {
		h := newTestHandler(t)
		registerTestUser(t, h, "bob", "bob@test.local")

		send := postJSON(h, h.SendCode, "", `{"email":"bob@test.local"}`)
		code := decodeMap(t, send)["debugCode"].(string)

		w := postJSON(h, h.VerifyCode, "", `{"email":"bob@test.local","code":"`+code+`"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		resp := decodeMap(t, w)
		if resp["isNew"] != false {
			t.Errorf("isNew = %v, want false", resp["isNew"])
		}
		if resp["token"] == "" {
			t.Error("expected refreshed token for existing user")
		}
	})
}

func TestIsValidEmail(t *testing.T) {
	cases := map[string]bool{
		"alice@test.local":    true,
		"a.b+c@example.co.uk": true,
		"alice@test.local ":   false, // trailing space
		" Name <a@b.local>":   false, // display name form must be rejected
		"not-an-email":        false,
		"a@@b.local":          false,
		"@test.local":         false,
		"alice@":              false,
		"":                    false,
	}

	for in, want := range cases {
		if got := isValidEmail(in); got != want {
			t.Errorf("isValidEmail(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestGenerateCode(t *testing.T) {
	seen := map[string]bool{}

	for range 200 {
		code, err := generateCode()
		if err != nil {
			t.Fatalf("generateCode: %v", err)
		}

		if len(code) != 6 {
			t.Fatalf("code %q has wrong length", code)
		}

		for _, r := range code {
			if r < '0' || r > '9' {
				t.Fatalf("code %q contains non-digit %q", code, r)
			}
		}

		seen[code] = true
	}

	if len(seen) < 100 {
		t.Error("expected code diversity across 200 draws")
	}
}
