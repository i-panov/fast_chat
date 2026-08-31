package store

import (
	"testing"
	"time"
)

func newCodeStore() *CodeStore {
	return NewCodeStore()
}

func TestVerifyCode(t *testing.T) {
	t.Run("correct code verifies and is consumed", func(t *testing.T) {
		s := newCodeStore()
		s.StoreCode("user@test.local", "123456", time.Minute)

		if !s.VerifyCode("user@test.local", "123456") {
			t.Fatal("correct code should verify")
		}

		if s.VerifyCode("user@test.local", "123456") {
			t.Fatal("verification code must be single-use")
		}
	})

	t.Run("wrong code is rejected and code retained", func(t *testing.T) {
		s := newCodeStore()
		s.StoreCode("user@test.local", "123456", time.Minute)

		if s.VerifyCode("user@test.local", "000000") {
			t.Fatal("wrong code must not verify")
		}

		if !s.VerifyCode("user@test.local", "123456") {
			t.Fatal("retry with the correct code should still verify")
		}
	})

	t.Run("unknown email", func(t *testing.T) {
		s := newCodeStore()

		if s.VerifyCode("missing@test.local", "123456") {
			t.Fatal("no code stored for unknown email")
		}
	})

	t.Run("expired code is rejected and removed", func(t *testing.T) {
		s := newCodeStore()
		s.StoreCode("user@test.local", "123456", 0)

		if s.VerifyCode("user@test.local", "123456") {
			t.Fatal("expired code must not verify")
		}

		if s.VerifyCode("user@test.local", "123456") {
			t.Fatal("expired code should have been removed")
		}
	})
}

func TestSetupToken(t *testing.T) {
	t.Run("create and verify", func(t *testing.T) {
		s := newCodeStore()

		token := s.CreateSetupToken("user@test.local", time.Minute)
		if token == "" {
			t.Fatal("expected non-empty setup token")
		}

		email, ok := s.VerifySetupToken(token)
		if !ok || email != "user@test.local" {
			t.Fatalf("got (%q, %v), want (user@test.local, true)", email, ok)
		}
	})

	t.Run("tokens are unique", func(t *testing.T) {
		s := newCodeStore()

		a := s.CreateSetupToken("a@test.local", time.Minute)
		b := s.CreateSetupToken("b@test.local", time.Minute)

		if a == "" || b == "" || a == b {
			t.Fatal("setup tokens must be unique")
		}
	})

	t.Run("single use", func(t *testing.T) {
		s := newCodeStore()

		token := s.CreateSetupToken("user@test.local", time.Minute)
		if _, ok := s.VerifySetupToken(token); !ok {
			t.Fatal("first verify should succeed")
		}

		if _, ok := s.VerifySetupToken(token); ok {
			t.Fatal("setup token must be single-use")
		}
	})

	t.Run("expired token", func(t *testing.T) {
		s := newCodeStore()

		token := s.CreateSetupToken("user@test.local", 0)
		if _, ok := s.VerifySetupToken(token); ok {
			t.Fatal("expired setup token must be rejected")
		}
	})

	t.Run("unknown token", func(t *testing.T) {
		s := newCodeStore()

		if _, ok := s.VerifySetupToken("nope"); ok {
			t.Fatal("unknown setup token must be rejected")
		}
	})
}

func TestCleanup(t *testing.T) {
	s := newCodeStore()

	s.StoreCode("fresh@test.local", "111111", time.Hour)
	s.StoreCode("stale@test.local", "222222", 0)

	freshToken := s.CreateSetupToken("fresh-token@test.local", time.Hour)
	staleToken := s.CreateSetupToken("stale-token@test.local", 0)

	s.Cleanup()

	if !s.VerifyCode("fresh@test.local", "111111") {
		t.Fatal("fresh code should survive cleanup")
	}
	if s.VerifyCode("stale@test.local", "222222") {
		t.Fatal("stale code should be removed by cleanup")
	}

	email, ok := s.VerifySetupToken(freshToken)
	if !ok || email != "fresh-token@test.local" {
		t.Error("fresh setup token should survive cleanup")
	}
	if _, ok := s.VerifySetupToken(staleToken); ok {
		t.Error("stale setup token should be removed by cleanup")
	}
}

func TestGenerateSetupTokenFormat(t *testing.T) {
	token, err := generateSetupToken()
	if err != nil {
		t.Fatalf("generateSetupToken: %v", err)
	}

	if len(token) != 64 {
		t.Errorf("expected 64 hex chars, got %d", len(token))
	}

	for _, r := range token {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Errorf("token contains non-hex rune %q", r)
		}
	}
}
