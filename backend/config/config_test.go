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
	if cfg.RateLimits.General.Limit != 100 {
		t.Errorf("expected General.Limit=100, got %d", cfg.RateLimits.General.Limit)
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
