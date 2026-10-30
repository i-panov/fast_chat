// Package config provides configuration loading from YAML files.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	ErrDatabasePathRequired = errors.New("database.path is required")
	ErrServerHostRequired   = errors.New("server.host is required")
	ErrInvalidPort          = errors.New("server.port must be 1..65535")
	ErrInvalidTTL           = errors.New("message_edit_ttl/message_delete_ttl must be >= 0")
	ErrInvalidFedScheme     = errors.New("federation.scheme must be http or https")
	ErrInvalidFedTimeout    = errors.New("federation.timeout must be 1..300 seconds")
	ErrInvalidSMTPPort      = errors.New("email.smtp.port must be 1..65535")
	ErrInvalidTokenExpiry   = errors.New("auth.token_expiry must be > 0")
	ErrInvalidTokenWarning  = errors.New("auth.token_expiry_warning must be > 0")
	ErrTokenWarningTooLarge = errors.New("auth.token_expiry_warning must be less than auth.token_expiry")
	ErrInvalidRateLimit     = errors.New("rate_limits entry must have limit > 0 and window > 0")
	ErrInvalidVAPIDSubject  = errors.New("push.vapid_subject must be a mailto: or http(s):// URL")
	ErrInvalidTURNConfig    = errors.New("ice.turn entry must list at least one non-empty url")
	ErrInvalidCORSOrigin    = errors.New("cors.origin must be an http(s)://host[:port] origin or empty")
	ErrSecretNotRegular     = errors.New("secret file must be a regular file")
	ErrSecretFilePermissive = errors.New("secret file permissions must be 0600")
)

// federationSchemeHTTPS is the default and only production scheme for
// federation traffic.
const federationSchemeHTTPS = "https"

type Config struct {
	MessageEditTTL   int              `yaml:"message_edit_ttl"`
	MessageDeleteTTL int              `yaml:"message_delete_ttl"`
	Server           ServerConfig     `yaml:"server"`
	Database         DatabaseConfig   `yaml:"database"`
	Uploads          UploadsConfig    `yaml:"uploads"`
	CORS             CORSConfig       `yaml:"cors"`
	Federation       FederationConfig `yaml:"federation"`
	Email            EmailConfig      `yaml:"email"`
	Push             PushConfig       `yaml:"push"`
	Auth             AuthConfig       `yaml:"auth"`
	RateLimits       RateLimitsConfig `yaml:"rate_limits"`
	ICE              ICEConfig        `yaml:"ice"`
}

type ServerConfig struct {
	Host      string `yaml:"host"`
	Port      int    `yaml:"port"`
	Domain    string `yaml:"-"` // computed from Host + Port
	StaticDir string `yaml:"static_dir"`
	// TrustedProxies lists the IPs/CIDRs of reverse proxies in front of this
	// server, so the client address can be recovered from X-Forwarded-For.
	//
	// List proxy hops only, never the address space of real clients. The
	// resolver walks the forwarding chain from the right and skips every entry
	// that falls inside a trusted range, so a client connecting from a trusted
	// range is indistinguishable from a proxy: it gets skipped and the address
	// it forged to its left becomes the rate limit key.
	TrustedProxies []string `yaml:"trusted_proxies"`
}

type DatabaseConfig struct {
	Path string `yaml:"path"`
}

type UploadsConfig struct {
	Dir string `yaml:"dir"`
}

type CORSConfig struct {
	Origin string `yaml:"origin"`
}

type FederationConfig struct {
	Scheme  string `yaml:"scheme"`
	Timeout int    `yaml:"timeout"`
	KeyPath string `yaml:"key_path"`
	// AllowPrivateAddresses lifts the SSRF protection of the federation
	// client, so peers on the loopback or a private network can be reached.
	// It exists for the local setup with several instances and must stay off
	// in production.
	AllowPrivateAddresses bool `yaml:"allow_private_addresses"`
}

// ICEConfig lists the ICE servers a browser may use to reach its peer.
type ICEConfig struct {
	STUN []string     `json:"stun" yaml:"stun"`
	TURN []TURNServer `json:"turn" yaml:"turn"`
}

// TURNServer is one relay for the media stream. The credentials are handed
// to every authorized client, so a static password makes the relay usable by
// anyone who can open the site — the TURN REST API is the safer setup.
type TURNServer struct {
	URLs []string `json:"urls" yaml:"urls"` //nolint:tagliatelle // the field name is fixed by the WebRTC API
	// Secret is the shared key of the TURN REST API: coturn is started with
	// use-auth-secret and the same static-auth-secret, and every client gets
	// its own short-lived password instead of a shared one. The key never
	// leaves the server, so it has no JSON name at all.
	Secret     string `json:"-"          yaml:"secret"`
	Username   string `json:"username"   yaml:"username"`
	Credential string `json:"credential" yaml:"credential"`
}

type EmailConfig struct {
	DebugMode     bool       `yaml:"debug_mode"`
	SMTP          SMTPConfig `yaml:"smtp"`
	AllowedEmails []string   `yaml:"allowed_emails"`
}

type SMTPConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	From     string `yaml:"from"`
}

type PushConfig struct {
	VAPIDSubject string `yaml:"vapid_subject"`
	KeyPath      string `yaml:"key_path"`
}

type AuthConfig struct {
	TokenExpiry        time.Duration `yaml:"token_expiry"`
	TokenExpiryWarning time.Duration `yaml:"token_expiry_warning"`
}

type RateLimitsConfig struct {
	SendCode   RateLimitConfig `yaml:"send_code"`
	VerifyCode RateLimitConfig `yaml:"verify_code"`
	Register   RateLimitConfig `yaml:"register"`
	General    RateLimitConfig `yaml:"general"`
}

type RateLimitConfig struct {
	Limit  int           `yaml:"limit"`
	Window time.Duration `yaml:"window"`
}

// applyICEDefaults fills the ICE lists, so the client never receives null:
// a configuration without the section would break it.
func applyICEDefaults(cfg *Config) {
	if cfg.ICE.STUN == nil {
		cfg.ICE.STUN = []string{}
	}

	if cfg.ICE.TURN == nil {
		cfg.ICE.TURN = []TURNServer{}
	}
}

// applyEnvOverrides applies the environment variables on top of the values
// read from the file. The variables exist so a second local instance can run
// from the same configuration file: the port, the database and the uploads
// directory have to differ, and the domain follows from the port.
//
// Secrets never come from YAML alone: FASTCHAT_SMTP_PASSWORD (or
// FASTCHAT_SMTP_PASSWORD_FILE) overrides smtp.password, and
// FASTCHAT_TURN_SECRET (or FASTCHAT_TURN_SECRET_FILE) overrides the secret of
// every configured TURN server. A *_FILE value is a path to a file holding
// the secret (mode 0600); it wins over the plain variable when both are set.
func applyEnvOverrides(cfg *Config) error {
	if host := os.Getenv("FASTCHAT_HOST"); host != "" {
		cfg.Server.Host = host
	}

	if port := os.Getenv("FASTCHAT_PORT"); port != "" {
		parsed, err := strconv.Atoi(strings.TrimSpace(port))
		if err != nil || parsed < 1 || parsed > 65535 {
			return fmt.Errorf("%w: FASTCHAT_PORT=%q", ErrInvalidPort, port)
		}

		cfg.Server.Port = parsed
	}

	if path := os.Getenv("FASTCHAT_DB_PATH"); path != "" {
		cfg.Database.Path = path
	}

	if dir := os.Getenv("FASTCHAT_UPLOADS_DIR"); dir != "" {
		cfg.Uploads.Dir = dir
	}

	if origin := os.Getenv("FASTCHAT_CORS_ORIGIN"); origin != "" {
		cfg.CORS.Origin = origin
	}

	if scheme := os.Getenv("FASTCHAT_FEDERATION_SCHEME"); scheme != "" {
		cfg.Federation.Scheme = scheme
	}

	if secret, err := readSecret("FASTCHAT_SMTP_PASSWORD", "FASTCHAT_SMTP_PASSWORD_FILE"); err != nil {
		return err
	} else if secret != "" {
		cfg.Email.SMTP.Password = secret
	}

	if secret, err := readSecret("FASTCHAT_TURN_SECRET", "FASTCHAT_TURN_SECRET_FILE"); err != nil {
		return err
	} else if secret != "" {
		for i := range cfg.ICE.TURN {
			cfg.ICE.TURN[i].Secret = secret
		}
	}

	return nil
}

// readSecret returns a secret from a plain env var or a file holding it.
// The file wins when both are set. The file must be mode 0600 (no group/other
// permissions) so a secret does not leak through backups or shared dirs.
func readSecret(envName, fileEnvName string) (string, error) {
	if path := strings.TrimSpace(os.Getenv(fileEnvName)); path != "" {
		cleanPath := filepath.Clean(path)
		info, err := os.Stat(cleanPath) //nolint:gosec // operator-controlled env path, not request input
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileEnvName, err)
		}

		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("%w: %s", ErrSecretNotRegular, fileEnvName)
		}

		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			return "", fmt.Errorf("%w: %s has %04o", ErrSecretFilePermissive, fileEnvName, perm)
		}

		data, err := os.ReadFile(cleanPath) //nolint:gosec // operator-controlled env path, not request input
		if err != nil {
			return "", fmt.Errorf("read %s: %w", fileEnvName, err)
		}

		return strings.TrimSpace(string(data)), nil
	}

	return strings.TrimSpace(os.Getenv(envName)), nil
}

func Load(configPath string) (*Config, error) {
	data, err := os.ReadFile(filepath.Clean(configPath))
	if err != nil {
		return nil, fmt.Errorf("failed to read config file %s: %w", configPath, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	if cfg.Database.Path == "" {
		return nil, ErrDatabasePathRequired
	}

	if cfg.Server.Host == "" {
		return nil, ErrServerHostRequired
	}

	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8080
	}

	// The environment overrides the file: it is what makes a second local
	// instance possible without a second configuration file.
	if err := applyEnvOverrides(&cfg); err != nil {
		return nil, err
	}

	cfg.Server.Domain = net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))

	applyDefaults(&cfg)
	applyICEDefaults(&cfg)

	// Filesystem paths are resolved against the config file directory so the
	// server does not depend on the working directory it was started from.
	resolveConfigPaths(&cfg, filepath.Dir(configPath))

	if err := validateConfig(&cfg); err != nil {
		return nil, err
	}

	slog.Info("config loaded",
		"database_path", cfg.Database.Path,
		"uploads_dir", cfg.Uploads.Dir,
		"push_key_path", cfg.Push.KeyPath,
		"federation_key_path", cfg.Federation.KeyPath,
	)

	return &cfg, nil
}

// applyDefaults fills the zero values documented in prod.yaml.example so the
// rest of the server can rely on them being set.
func applyDefaults(cfg *Config) {
	if cfg.MessageEditTTL == 0 {
		cfg.MessageEditTTL = 300
	}

	if cfg.MessageDeleteTTL == 0 {
		cfg.MessageDeleteTTL = 300
	}

	if cfg.Email.SMTP.From == "" {
		cfg.Email.SMTP.From = "noreply@fastchat.local"
	}

	if cfg.Email.SMTP.Port == 0 {
		cfg.Email.SMTP.Port = 587
	}

	if cfg.Uploads.Dir == "" {
		cfg.Uploads.Dir = "uploads"
	}

	if cfg.Auth.TokenExpiry == 0 {
		cfg.Auth.TokenExpiry = 24 * time.Hour
	}

	if cfg.Auth.TokenExpiryWarning == 0 {
		cfg.Auth.TokenExpiryWarning = 5 * time.Minute
	}

	if cfg.Push.KeyPath == "" {
		cfg.Push.KeyPath = "./keys"
	}

	if cfg.Federation.Scheme == "" {
		cfg.Federation.Scheme = federationSchemeHTTPS
	}

	if cfg.Federation.Timeout == 0 {
		cfg.Federation.Timeout = 10
	}

	setRateLimitDefaults(&cfg.RateLimits.General, 600, time.Minute)
	setRateLimitDefaults(&cfg.RateLimits.SendCode, 5, time.Minute)
	setRateLimitDefaults(&cfg.RateLimits.VerifyCode, 10, time.Minute)
	setRateLimitDefaults(&cfg.RateLimits.Register, 5, 10*time.Minute)
}

// setRateLimitDefaults fills one limiter entry without touching explicitly
// configured values.
func setRateLimitDefaults(rl *RateLimitConfig, limit int, window time.Duration) {
	if rl.Limit == 0 {
		rl.Limit = limit
	}

	if rl.Window == 0 {
		rl.Window = window
	}
}

// IsValidCORSOrigin reports whether origin is a usable CORS origin: an
// http(s) URL with a host and no path, query or fragment. "*" is rejected
// here; callers keep it only for backward-compatible tests/dev setups.
func IsValidCORSOrigin(origin string) bool {
	return isValidCORSOrigin(origin)
}

func isValidCORSOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || !parsed.IsAbs() {
		return false
	}

	if parsed.Scheme != "http" && parsed.Scheme != federationSchemeHTTPS {
		return false
	}

	if parsed.Host == "" || parsed.User != nil {
		return false
	}

	// A trailing slash never matches the browser's Origin header (which
	// carries no path), so "https://host/" would silently break CORS.
	// Reject it here instead of normalizing: a typo in config must fail
	// loudly at startup, not as mysterious cross-origin errors.
	if parsed.Path != "" {
		return false
	}

	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}

	if strings.ContainsAny(origin, " \t\r\n") {
		return false
	}

	return true
}

// resolveConfigPaths turns relative filesystem paths into absolute ones
// anchored at the config file directory.
func resolveConfigPaths(cfg *Config, baseDir string) {
	absBase, err := filepath.Abs(baseDir)
	if err != nil {
		return
	}

	resolve := func(p string) string {
		if p == "" || filepath.IsAbs(p) {
			return p
		}

		return filepath.Join(absBase, p)
	}

	cfg.Database.Path = resolve(cfg.Database.Path)
	cfg.Uploads.Dir = resolve(cfg.Uploads.Dir)
	cfg.Push.KeyPath = resolve(cfg.Push.KeyPath)
	cfg.Federation.KeyPath = resolve(cfg.Federation.KeyPath)
}

// validateConfig fail-fasts on values that would otherwise start the server
// in a broken or insecure state (negative limits, wrong schemes, bad ports).
func validateConfig(cfg *Config) error {
	if cfg.Server.Port < 1 || cfg.Server.Port > 65535 {
		return fmt.Errorf("%w: got %d", ErrInvalidPort, cfg.Server.Port)
	}

	if cfg.MessageEditTTL < 0 || cfg.MessageDeleteTTL < 0 {
		return fmt.Errorf("%w: got %d/%d", ErrInvalidTTL, cfg.MessageEditTTL, cfg.MessageDeleteTTL)
	}

	if err := validateFederation(&cfg.Federation); err != nil {
		return err
	}

	if err := validateAuth(&cfg.Auth); err != nil {
		return err
	}

	if err := validateRateLimits(&cfg.RateLimits); err != nil {
		return err
	}

	if err := validateEmailAndPush(&cfg.Email, &cfg.Push); err != nil {
		return err
	}

	if err := validateTURN(cfg.ICE.TURN); err != nil {
		return err
	}

	if cfg.CORS.Origin != "" && cfg.CORS.Origin != "*" && !isValidCORSOrigin(cfg.CORS.Origin) {
		return fmt.Errorf("%w: got %q", ErrInvalidCORSOrigin, cfg.CORS.Origin)
	}

	return nil
}

// validateFederation checks the outbound federation scheme and timeout.
func validateFederation(fed *FederationConfig) error {
	switch fed.Scheme {
	case "http", federationSchemeHTTPS:
	default:
		return fmt.Errorf("%w: got %q", ErrInvalidFedScheme, fed.Scheme)
	}

	if fed.Timeout < 1 || fed.Timeout > 300 {
		return fmt.Errorf("%w: got %d", ErrInvalidFedTimeout, fed.Timeout)
	}

	return nil
}

// validateAuth checks the session token lifetime and its warning window.
func validateAuth(auth *AuthConfig) error {
	if auth.TokenExpiry <= 0 {
		return fmt.Errorf("%w: got %v", ErrInvalidTokenExpiry, auth.TokenExpiry)
	}

	if auth.TokenExpiryWarning <= 0 {
		return fmt.Errorf("%w: got %v", ErrInvalidTokenWarning, auth.TokenExpiryWarning)
	}

	if auth.TokenExpiryWarning >= auth.TokenExpiry {
		return fmt.Errorf(
			"%w: warning %v vs expiry %v",
			ErrTokenWarningTooLarge, auth.TokenExpiryWarning, auth.TokenExpiry,
		)
	}

	return nil
}

// validateRateLimits checks every limiter entry.
func validateRateLimits(rls *RateLimitsConfig) error {
	for name, entry := range map[string]RateLimitConfig{
		"general":     rls.General,
		"send_code":   rls.SendCode,
		"verify_code": rls.VerifyCode,
		"register":    rls.Register,
	} {
		if entry.Limit <= 0 || entry.Window <= 0 {
			return fmt.Errorf("%w: %s got %d/%v", ErrInvalidRateLimit, name, entry.Limit, entry.Window)
		}
	}

	return nil
}

// validateEmailAndPush checks the SMTP port and the VAPID subject format.
func validateEmailAndPush(email *EmailConfig, push *PushConfig) error {
	if email.SMTP.Port < 1 || email.SMTP.Port > 65535 {
		return fmt.Errorf("%w: got %d", ErrInvalidSMTPPort, email.SMTP.Port)
	}

	if !isValidVAPIDSubject(push.VAPIDSubject) {
		return fmt.Errorf("%w: got %q", ErrInvalidVAPIDSubject, push.VAPIDSubject)
	}

	return nil
}

// isValidVAPIDSubject reports whether the subject is empty (unset) or a
// mailto:/http(s):// URL.
func isValidVAPIDSubject(subject string) bool {
	if subject == "" {
		return true
	}

	return strings.HasPrefix(subject, "mailto:") ||
		strings.HasPrefix(subject, "https://") ||
		strings.HasPrefix(subject, "http://")
}

// validateTURN checks that every relay entry lists a usable URL.
func validateTURN(servers []TURNServer) error {
	for idx, server := range servers {
		if len(server.URLs) == 0 {
			return fmt.Errorf("%w: ice.turn[%d]", ErrInvalidTURNConfig, idx)
		}

		for _, rawURL := range server.URLs {
			if strings.TrimSpace(rawURL) == "" {
				return fmt.Errorf("%w: ice.turn[%d] has an empty url", ErrInvalidTURNConfig, idx)
			}
		}
	}

	return nil
}
