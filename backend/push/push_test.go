package push

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

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

	t.Run("corrupt key file is fatal", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "vapid_keys.json")

		if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
			t.Fatal(err)
		}

		if _, err := loadOrGenerateVAPIDKeys(dir); !errors.Is(err, errVAPIDKeysUnreadable) {
			t.Fatalf("load = %v, want errVAPIDKeysUnreadable", err)
		}

		// The unreadable file must be left in place for the operator to
		// restore; silently rewriting it would invalidate every subscription.
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "not json" {
			t.Fatalf("file was rewritten: %q", data)
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
