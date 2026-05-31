package config

import (
	"os"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	os.Unsetenv("MESSAGE_EDIT_TTL")
	os.Unsetenv("MESSAGE_DELETE_TTL")
	os.Unsetenv("SERVER_DOMAIN")

	cfg := Load()

	if cfg.MessageEditTTL != 300 {
		t.Errorf("expected MessageEditTTL=300, got %d", cfg.MessageEditTTL)
	}
	if cfg.MessageDeleteTTL != 0 {
		t.Errorf("expected MessageDeleteTTL=0, got %d", cfg.MessageDeleteTTL)
	}
	if cfg.ServerDomain != "localhost:8080" {
		t.Errorf("expected ServerDomain=localhost:8080, got %s", cfg.ServerDomain)
	}
}

func TestLoadCustom(t *testing.T) {
	os.Setenv("MESSAGE_EDIT_TTL", "600")
	os.Setenv("MESSAGE_DELETE_TTL", "120")
	os.Setenv("SERVER_DOMAIN", "example.com:9090")
	defer func() {
		os.Unsetenv("MESSAGE_EDIT_TTL")
		os.Unsetenv("MESSAGE_DELETE_TTL")
		os.Unsetenv("SERVER_DOMAIN")
	}()

	cfg := Load()

	if cfg.MessageEditTTL != 600 {
		t.Errorf("expected MessageEditTTL=600, got %d", cfg.MessageEditTTL)
	}
	if cfg.MessageDeleteTTL != 120 {
		t.Errorf("expected MessageDeleteTTL=120, got %d", cfg.MessageDeleteTTL)
	}
	if cfg.ServerDomain != "example.com:9090" {
		t.Errorf("expected ServerDomain=example.com:9090, got %s", cfg.ServerDomain)
	}
}

func TestLoadInvalidInt(t *testing.T) {
	os.Setenv("MESSAGE_EDIT_TTL", "not-a-number")
	defer os.Unsetenv("MESSAGE_EDIT_TTL")

	cfg := Load()

	if cfg.MessageEditTTL != 300 {
		t.Errorf("expected fallback MessageEditTTL=300, got %d", cfg.MessageEditTTL)
	}
}
