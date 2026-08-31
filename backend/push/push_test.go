package push

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTruncate(t *testing.T) {
	ascii := []struct {
		in   string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 5, "hello"},
		{"hello world", 5, "hello..."},
		{"hello world", 11, "hello world"},
		{"", 5, ""},
		{"", 0, ""},
	}

	for _, tc := range ascii {
		if got := truncate(tc.in, tc.max); got != tc.want {
			t.Errorf("truncate(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
		}
	}

	// Deterministic UTF-8 case: boundaries align so no rune is split.
	if got := truncate("привет", 4); got != "пр..." {
		t.Errorf("truncate(привет, 4) = %q, want пр...", got)
	}
}

func TestLoadOrGenerateVAPIDKeys(t *testing.T) {
	t.Run("generates valid keys on first call", func(t *testing.T) {
		keys, err := loadOrGenerateVAPIDKeys(t.TempDir())
		if err != nil {
			t.Fatalf("loadOrGenerateVAPIDKeys: %v", err)
		}

		if keys.PublicKey == "" || keys.PrivateKey == "" {
			t.Fatal("expected non-empty VAPID key pair")
		}
	})

	t.Run("reloads the same keys", func(t *testing.T) {
		dir := t.TempDir()

		first, err := loadOrGenerateVAPIDKeys(dir)
		if err != nil {
			t.Fatalf("first: %v", err)
		}

		second, err := loadOrGenerateVAPIDKeys(dir)
		if err != nil {
			t.Fatalf("second: %v", err)
		}

		if first.PublicKey != second.PublicKey || first.PrivateKey != second.PrivateKey {
			t.Error("reload produced different VAPID keys")
		}
	})

	t.Run("private key file is not world-readable", func(t *testing.T) {
		dir := t.TempDir()

		if _, err := loadOrGenerateVAPIDKeys(dir); err != nil {
			t.Fatalf("load: %v", err)
		}

		std, err := os.Stat(filepath.Join(dir, "vapid_keys.json"))
		if err != nil {
			t.Fatalf("stat: %v", err)
		}

		if std.Mode().Perm()&0o077 != 0 {
			t.Errorf("VAPID key file has world/group bits: %o", std.Mode().Perm())
		}
	})

	t.Run("corrupt key file triggers regeneration", func(t *testing.T) {
		dir := t.TempDir()

		if err := os.WriteFile(filepath.Join(dir, "vapid_keys.json"), []byte("not json"), 0o600); err != nil {
			t.Fatal(err)
		}

		keys, err := loadOrGenerateVAPIDKeys(dir)
		if err != nil {
			t.Fatalf("load: %v", err)
		}

		if keys.PublicKey == "" {
			t.Error("expected regeneration to yield a public key")
		}
	})
}

func TestPublicKeyService(t *testing.T) {
	dir := t.TempDir()

	s, err := NewService("mailto:admin@example.com", dir, nil)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	if s.PublicKey() == "" {
		t.Fatal("PublicKey should be non-empty")
	}
}
