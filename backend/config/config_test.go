package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeTestConfig(t *testing.T, content string) string {
	t.Helper()

	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	return path
}

func TestLoadDefaults(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.MessageEditTTL != 300 {
		t.Errorf("expected MessageEditTTL=300, got %d", cfg.MessageEditTTL)
	}
	if cfg.Server.Domain != "localhost:8080" {
		t.Errorf("expected Server.Domain=localhost:8080, got %s", cfg.Server.Domain)
	}
	if cfg.Auth.TokenExpiry != 24*time.Hour {
		t.Errorf("expected TokenExpiry=24h, got %v", cfg.Auth.TokenExpiry)
	}
	if cfg.RateLimits.General.Limit != 600 {
		t.Errorf("expected General.Limit=600, got %d", cfg.RateLimits.General.Limit)
	}
	if cfg.Uploads.Dir == "" {
		t.Error("expected Uploads.Dir default")
	}
}

func TestLoadCustom(t *testing.T) {
	yaml := `
server:
  host: example.com
  port: 9090
database:
  path: /tmp/test.db
message_edit_ttl: 600
message_delete_ttl: 120
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.MessageEditTTL != 600 {
		t.Errorf("expected MessageEditTTL=600, got %d", cfg.MessageEditTTL)
	}
	if cfg.MessageDeleteTTL != 120 {
		t.Errorf("expected MessageDeleteTTL=120, got %d", cfg.MessageDeleteTTL)
	}
	if cfg.Server.Domain != "example.com:9090" {
		t.Errorf("expected Server.Domain=example.com:9090, got %s", cfg.Server.Domain)
	}
}

func TestLoadDefaultPort(t *testing.T) {
	yaml := `
server:
  host: localhost
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 8080 {
		t.Errorf("expected Port=8080, got %d", cfg.Server.Port)
	}
	if cfg.Server.Domain != "localhost:8080" {
		t.Errorf("expected Domain=localhost:8080, got %s", cfg.Server.Domain)
	}
}

func TestLoadMissingPath(t *testing.T) {
	_, err := Load("/nonexistent/config.yaml")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestLoadRejectsBadValues(t *testing.T) {
	header := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	cases := map[string]string{
		"bad port":       "server:\n  host: localhost\n  port: 99999\ndatabase:\n  path: /tmp/test.db\n",
		"bad scheme":     header + "federation:\n  scheme: ftp\n",
		"bad timeout":    header + "federation:\n  timeout: -5\n",
		"bad rate limit": header + "rate_limits:\n  general:\n    limit: -1\n",
		"bad token warn": header + "auth:\n  token_expiry: 5m\n  token_expiry_warning: 10m\n",
		"bad cors":       header + "cors:\n  origin: 'ftp://evil'\n",
		"bad turn urls":  header + "ice:\n  turn:\n    - urls: []\n",
		"bad vapid":      header + "push:\n  vapid_subject: not-a-url\n",
		"negative ttl":   header + "message_edit_ttl: -1\n",
	}

	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(writeTestConfig(t, doc)); err == nil {
				t.Fatalf("expected error for %s", name)
			}
		})
	}
}

func TestLoadInvalidPortEnvFails(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_PORT", "not-a-number")

	if _, err := Load(writeTestConfig(t, yaml)); err == nil {
		t.Fatal("expected error for invalid FASTCHAT_PORT, got nil")
	}
}

func TestLoadSecretFromEnv(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
email:
  smtp:
    host: smtp.example.com
`
	t.Setenv("FASTCHAT_SMTP_PASSWORD", "s3cret")

	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Email.SMTP.Password != "s3cret" {
		t.Errorf("password = %q, want s3cret", cfg.Email.SMTP.Password)
	}
}

func TestLoadSecretFromFile(t *testing.T) {
	dir := t.TempDir()
	secretPath := dir + "/smtp.pass"

	if err := os.WriteFile(secretPath, []byte("file-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_SMTP_PASSWORD_FILE", secretPath)

	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Email.SMTP.Password != "file-secret" {
		t.Errorf("password = %q, want file-secret", cfg.Email.SMTP.Password)
	}
}

func TestLoadSecretFileBadPermsFails(t *testing.T) {
	dir := t.TempDir()
	secretPath := dir + "/smtp.pass"

	if err := os.WriteFile(secretPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_SMTP_PASSWORD_FILE", secretPath)

	if _, err := Load(writeTestConfig(t, yaml)); err == nil {
		t.Fatal("expected error for world-readable secret file, got nil")
	}
}

func TestLoadResolvesRelativePaths(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/config.yaml"
	content := `
server:
  host: localhost
  port: 8080
database:
  path: ./data/test.db
uploads:
  dir: uploads
push:
  key_path: ./keys
federation:
  key_path: ./fed
`

	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{cfg.Database.Path, cfg.Uploads.Dir, cfg.Push.KeyPath, cfg.Federation.KeyPath} {
		if !filepath.IsAbs(p) {
			t.Errorf("path %q is not absolute", p)
		}
	}

	if !filepath.HasPrefix(cfg.Database.Path, dir) {
		t.Errorf("database path %q not anchored at config dir %q", cfg.Database.Path, dir)
	}
}

func TestIsValidCORSOrigin(t *testing.T) {
	for _, ok := range []string{"http://localhost:5173", "https://chat.example.com"} {
		if !IsValidCORSOrigin(ok) {
			t.Errorf("IsValidCORSOrigin(%q) = false, want true", ok)
		}
	}

	for _, bad := range []string{"", "*", "ftp://x", "http://x/path", "http://x?q=1", "not-a-url", "http://", "https://chat.example.com/"} {
		if IsValidCORSOrigin(bad) {
			t.Errorf("IsValidCORSOrigin(%q) = true, want false", bad)
		}
	}
}
