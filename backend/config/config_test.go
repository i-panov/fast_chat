package config

import (
	"errors"
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
	if cfg.Auth.MaxSessionsPerUser != 50 {
		t.Errorf("expected MaxSessionsPerUser=50, got %d", cfg.Auth.MaxSessionsPerUser)
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
		"bad port":          "server:\n  host: localhost\n  port: 99999\ndatabase:\n  path: /tmp/test.db\n",
		"bad scheme":        header + "federation:\n  scheme: ftp\n",
		"bad timeout":       header + "federation:\n  timeout: -5\n",
		"bad rate limit":    header + "rate_limits:\n  general:\n    limit: -1\n",
		"bad token warn":    header + "auth:\n  token_expiry: 5m\n  token_expiry_warning: 10m\n",
		"negative sessions": header + "auth:\n  max_sessions_per_user: -1\n",
		"bad cors":          header + "cors:\n  origin: 'ftp://evil'\n",
		"bad turn urls":     header + "ice:\n  turn:\n    - urls: []\n",
		"bad vapid":         header + "push:\n  vapid_subject: not-a-url\n",
		"negative ttl":      header + "message_edit_ttl: -1\n",
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

func TestLoadKeyPathsFromEnv(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_PUSH_KEY_PATH", "/tmp/test-push-keys")
	t.Setenv("FASTCHAT_FEDERATION_KEY_PATH", "/tmp/test-federation-keys")

	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Push.KeyPath != "/tmp/test-push-keys" {
		t.Errorf("push key path = %q, want /tmp/test-push-keys", cfg.Push.KeyPath)
	}

	if cfg.Federation.KeyPath != "/tmp/test-federation-keys" {
		t.Errorf("federation key path = %q, want /tmp/test-federation-keys", cfg.Federation.KeyPath)
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

func TestLoadPublicDomain(t *testing.T) {
	yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: fastchat.example.com
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Domain != "fastchat.example.com" {
		t.Errorf("expected Domain=fastchat.example.com, got %s", cfg.Server.Domain)
	}
	if cfg.Server.Host != "127.0.0.1" {
		t.Errorf("expected bind host to stay 127.0.0.1, got %s", cfg.Server.Host)
	}
}

func TestLoadPublicDomainWithPort(t *testing.T) {
	yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: chat.example.com:8443
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Domain != "chat.example.com:8443" {
		t.Errorf("expected Domain=chat.example.com:8443, got %s", cfg.Server.Domain)
	}
}

func TestLoadWildcardHostRequiresPublicDomain(t *testing.T) {
	yaml := `
server:
  host: 0.0.0.0
  port: 8085
database:
  path: /tmp/test.db
`
	if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrPublicDomainRequired) {
		t.Errorf("expected ErrPublicDomainRequired, got %v", err)
	}
}

func TestLoadWildcardHostWithPublicDomain(t *testing.T) {
	yaml := `
server:
  host: 0.0.0.0
  port: 8085
  public_domain: chat.example.com
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Domain != "chat.example.com" {
		t.Errorf("expected Domain=chat.example.com, got %s", cfg.Server.Domain)
	}
}

func TestLoadInvalidPublicDomain(t *testing.T) {
	for _, bad := range []string{
		"https://chat.example.com",
		"chat.example.com/",
		"chat.example.com:0",
		"chat.example.com:70000",
		" chat.example.com",
		"::1",
	} {
		yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: "` + bad + `"
database:
  path: /tmp/test.db
`
		if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrInvalidPublicDomain) {
			t.Errorf("public_domain=%q: expected ErrInvalidPublicDomain, got %v", bad, err)
		}
	}
}

func TestLoadPublicDomainFromEnv(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_PUBLIC_DOMAIN", "chat.example.org")

	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Domain != "chat.example.org" {
		t.Errorf("expected Domain=chat.example.org from env, got %s", cfg.Server.Domain)
	}
}

func TestLoadRejectsBadServerHost(t *testing.T) {
	cases := map[string]string{
		"scheme":       "https://example.com",
		"path":         "example.com/path",
		"trailing pad": "localhost ",
		"host:port":    "127.0.0.1:8080",
		"garbage v6":   "[::1",
	}

	for name, host := range cases {
		t.Run(name, func(t *testing.T) {
			yaml := `
server:
  host: "` + host + `"
  port: 8085
  public_domain: chat.example.com
database:
  path: /tmp/test.db
`
			if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrInvalidServerHost) {
				t.Errorf("host=%q: expected ErrInvalidServerHost, got %v", host, err)
			}
		})
	}
}

func TestLoadBracketedIPv6Host(t *testing.T) {
	yaml := `
server:
  host: "[::1]"
  port: 8085
  public_domain: chat.example.com
database:
  path: /tmp/test.db
`
	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Host != "::1" {
		t.Errorf("expected brackets stripped from bind host, got %q", cfg.Server.Host)
	}
	if cfg.Server.Domain != "chat.example.com" {
		t.Errorf("expected Domain=chat.example.com, got %q", cfg.Server.Domain)
	}
}

func TestLoadWildcardIPv6RequiresPublicDomain(t *testing.T) {
	for _, host := range []string{"::", "[::]", "0:0:0:0:0:0:0:0"} {
		yaml := `
server:
  host: "` + host + `"
  port: 8085
database:
  path: /tmp/test.db
`
		if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrPublicDomainRequired) {
			t.Errorf("host=%q: expected ErrPublicDomainRequired, got %v", host, err)
		}
	}
}

func TestLoadRejectsWildcardPublicDomain(t *testing.T) {
	for _, domain := range []string{"0.0.0.0", "0.0.0.0:8080", "::", "[::]:443"} {
		yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: "` + domain + `"
database:
  path: /tmp/test.db
`
		if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrInvalidPublicDomain) {
			t.Errorf("public_domain=%q: expected ErrInvalidPublicDomain, got %v", domain, err)
		}
	}
}

func TestLoadNormalizesPublicDomain(t *testing.T) {
	cases := map[string]string{
		"EXAMPLE.com.":         "example.com",
		"Chat.Example.COM":     "chat.example.com",
		"chat.example.com:443": "chat.example.com:443",
		"[2001:db8::1]:443":    "[2001:db8::1]:443",
	}

	for in, want := range cases {
		yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: "` + in + `"
database:
  path: /tmp/test.db
`
		cfg, err := Load(writeTestConfig(t, yaml))
		if err != nil {
			t.Fatalf("public_domain=%q: %v", in, err)
		}

		if cfg.Server.Domain != want {
			t.Errorf("public_domain=%q: Domain=%q, want %q", in, cfg.Server.Domain, want)
		}
	}
}

func TestLoadRejectsBadPublicDomainSuffix(t *testing.T) {
	for _, domain := range []string{"chat.example.com:", "chat.example.com?x=1", "chat#example.com"} {
		yaml := `
server:
  host: 127.0.0.1
  port: 8085
  public_domain: "` + domain + `"
database:
  path: /tmp/test.db
`
		if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrInvalidPublicDomain) {
			t.Errorf("public_domain=%q: expected ErrInvalidPublicDomain, got %v", domain, err)
		}
	}
}

func TestLoadValidatesHostFromEnv(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8085
  public_domain: chat.example.com
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_HOST", "https://example.com")

	if _, err := Load(writeTestConfig(t, yaml)); !errors.Is(err, ErrInvalidServerHost) {
		t.Errorf("expected ErrInvalidServerHost from env, got %v", err)
	}
}

func TestLoadTrimsDomainFromEnv(t *testing.T) {
	yaml := `
server:
  host: localhost
  port: 8085
database:
  path: /tmp/test.db
`
	t.Setenv("FASTCHAT_PUBLIC_DOMAIN", "  chat.example.org\n")

	cfg, err := Load(writeTestConfig(t, yaml))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Server.Domain != "chat.example.org" {
		t.Errorf("expected trimmed Domain=chat.example.org, got %q", cfg.Server.Domain)
	}
}

// A production config must not silently accept the unsafe federation
// switches: plain http lets an MITM impersonate any peer.
func TestLoadRejectsUnsafeFederationOnAPublicDomain(t *testing.T) {
	cases := []struct {
		name string
		yaml string
		want bool
	}{
		{
			name: "http with a public domain",
			yaml: `
server:
  host: localhost
  port: 8080
  public_domain: chat.example.com
database:
  path: /tmp/test.db
federation:
  scheme: http
`,
			want: true,
		},
		{
			name: "private addresses with a public domain",
			yaml: `
server:
  host: localhost
  port: 8080
  public_domain: chat.example.com
database:
  path: /tmp/test.db
federation:
  allow_private_addresses: true
`,
			want: true,
		},
		{
			name: "http for the local setup",
			yaml: `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
federation:
  scheme: http
`,
			want: false,
		},
		{
			name: "https with a public domain",
			yaml: `
server:
  host: localhost
  port: 8080
  public_domain: chat.example.com
database:
  path: /tmp/test.db
federation:
  scheme: https
`,
			want: false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Load(writeTestConfig(t, c.yaml))
			if c.want && !errors.Is(err, ErrUnsafeFederation) {
				t.Fatalf("error = %v, want ErrUnsafeFederation", err)
			}
			if !c.want && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// The federation key path must have a default: an empty one made the process
// die with a cryptic mkdir error.
func TestLoadDefaultsFederationKeyPath(t *testing.T) {
	cfg, err := Load(writeTestConfig(t, `
server:
  host: localhost
  port: 8080
database:
  path: /tmp/test.db
`))
	if err != nil {
		t.Fatal(err)
	}

	if cfg.Federation.KeyPath == "" {
		t.Fatal("federation.key_path is empty, want the default")
	}
}
