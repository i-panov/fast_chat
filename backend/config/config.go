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
	ErrInvalidServerHost    = errors.New("server.host must be a bind address without scheme or path")
	ErrInvalidPublicDomain  = errors.New("server.public_domain must be host[:port] without scheme or path")
	ErrPublicDomainRequired = errors.New("server.public_domain is required when server.host is a wildcard address")
	ErrInvalidPort          = errors.New("server.port must be 1..65535")
	ErrInvalidTTL           = errors.New("message_edit_ttl/message_delete_ttl must be >= 0")
	ErrInvalidFedScheme     = errors.New("federation.scheme must be http or https")
	ErrInvalidFedTimeout    = errors.New("federation.timeout must be 1..300 seconds")
	ErrInvalidSMTPPort      = errors.New("email.smtp.port must be 1..65535")
	ErrInvalidTokenExpiry   = errors.New("auth.token_expiry must be > 0")
	ErrInvalidTokenWarning  = errors.New("auth.token_expiry_warning must be > 0")
	ErrTokenWarningTooLarge = errors.New("auth.token_expiry_warning must be less than auth.token_expiry")
	ErrInvalidMaxSessions   = errors.New("auth.max_sessions_per_user must be >= 0 (0 means the default 50)")
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

// maxHostLen is the DNS name limit (RFC 1035). Ids embed the domain, so an
// overlong value would grow every row that stores a user id.
const maxHostLen = 253

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
	// Host is the address the server binds to: "127.0.0.1" for a server
	// behind a local reverse proxy, "0.0.0.0" (or "::") for all interfaces.
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
	// PublicDomain is the address the server is reachable at from other
	// servers: it becomes the domain part of every user id (nick:domain) and
	// the target of federation requests. It may include a port.
	//
	// When empty it is derived from Host and Port. That fits development,
	// where the bind address is reachable too, but a production server behind
	// a TLS proxy on :443 must set it explicitly — otherwise every id carries
	// the internal port and peers would try to reach that port.
	PublicDomain string `yaml:"public_domain"`
	Domain       string `yaml:"-"` // computed from PublicDomain or Host + Port
	StaticDir    string `yaml:"static_dir"`
	// TrustedProxies lists the IPs/CIDRs of reverse proxies in front of this
	// server, so the client address can be recovered from X-Forwarded-For.
	//
	// List proxy hops only, never the address space of real clients. The
	// resolver walks the forwarding chain from the right and skips every entry
	// that falls inside a trusted range, so a client connecting from a trusted
	// range is indistinguishable from a proxy: it gets skipped and the address
	// it forged to its left becomes the rate limit key.
	TrustedProxies []string `yaml:"trusted_proxies"`
	// Admins lists the e-mail addresses that get the administrator role.
	// E-mail is verified before an account exists, so a configured entry
	// cannot be claimed by registering a username first.
	Admins []string `yaml:"admins"`
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
	// MaxSessionsPerUser caps the active devices of one account. The oldest
	// sessions above the cap are revoked on login. Zero means the default 50;
	// a negative value is invalid and unlimited is not supported.
	MaxSessionsPerUser int `yaml:"max_sessions_per_user"`
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

// resolveDomain derives the identity domain — the ":domain" part of every
// user id and the target of federation requests. An explicit public_domain
// wins; otherwise host:port is used, which is what a dev instance bound to
// localhost wants. A wildcard bind address has no usable identity of its own,
// so it demands an explicit public_domain instead of advertising "0.0.0.0".
func resolveDomain(host, publicDomain string, port int) (string, error) {
	if publicDomain != "" {
		return normalizePublicDomain(publicDomain)
	}

	if isWildcardHost(host) {
		return "", fmt.Errorf("%w: host=%q", ErrPublicDomainRequired, host)
	}

	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		slog.Warn("server.public_domain is empty while the bind address is not public;"+
			" user ids will carry this address", "host", host)
	}

	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// isWildcardHost reports whether the bind address covers every interface.
// Hosts are stored without brackets: normalizeServerHost strips them.
func isWildcardHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsUnspecified()
	}

	return false
}

// normalizeServerHost validates the bind address and returns it in the form
// net.JoinHostPort expects: brackets around IPv6 are removed, so "[::1]"
// becomes "::1" instead of turning into "[[::1]]:8080" later. A URL, a path or
// an address that already carries a port is rejected here, otherwise it would
// fail at listen time with an obscure error.
func normalizeServerHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)

	invalidHost := host == "" || host != raw ||
		strings.ContainsAny(host, " \t\r\n/") ||
		strings.Contains(host, "://")
	if invalidHost {
		return "", fmt.Errorf("%w: got %q", ErrInvalidServerHost, raw)
	}

	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}

	// A colon is allowed only inside an IPv6 literal: "127.0.0.1:8080" is a
	// common mistake and net.JoinHostPort would yield "[127.0.0.1:8080]:8080".
	if strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return "", fmt.Errorf("%w: got %q (the port has its own option)", ErrInvalidServerHost, raw)
	}

	if len(host) > maxHostLen {
		return "", fmt.Errorf("%w: got %d characters", ErrInvalidServerHost, len(host))
	}

	return host, nil
}

// normalizePublicDomain accepts "host", "host:port" and "[v6-addr]:port" and
// returns the canonical form stored in user ids: lower case, no trailing dot,
// IPv6 in brackets. A bare IPv6 literal is rejected because it is
// indistinguishable from "host:port" here. Characters the federation layer
// refuses later (see RemoteServerFromID) are rejected too, so a config that
// parses cannot produce ids that break federation.
func normalizePublicDomain(raw string) (string, error) {
	invalidDomain := raw != strings.TrimSpace(raw) ||
		strings.ContainsAny(raw, " \t\r\n/") ||
		strings.ContainsAny(raw, "@?#")
	if invalidDomain {
		return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
	}

	host, port := raw, ""

	switch {
	case strings.HasPrefix(raw, "["):
		h, p, err := net.SplitHostPort(raw)
		if err != nil {
			return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
		}

		host, port = h, p

	case strings.Count(raw, ":") == 1:
		h, p, err := net.SplitHostPort(raw)
		if err != nil || p == "" {
			return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
		}

		host, port = h, p

	case strings.Count(raw, ":") > 1:
		return "", fmt.Errorf("%w: got %q (bracket an IPv6 address as [addr]:port)",
			ErrInvalidPublicDomain, raw)
	}

	if host == "" {
		return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
	}

	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		return "", fmt.Errorf("%w: got %q (an unspecified address is not a public identity)",
			ErrInvalidPublicDomain, raw)
	}

	if port != "" {
		parsed, err := strconv.Atoi(port)
		if err != nil || parsed < 1 || parsed > 65535 {
			return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
		}

		port = strconv.Itoa(parsed)
	}

	host = strings.ToLower(strings.TrimSuffix(host, "."))

	if host == "" || len(host) > maxHostLen {
		return "", fmt.Errorf("%w: got %q", ErrInvalidPublicDomain, raw)
	}

	if port != "" {
		return net.JoinHostPort(host, port), nil
	}

	return host, nil
}

// splitList parses a comma-separated environment value, dropping empty
// entries so "alice,,bob," means two names.
func splitList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}

	return out
}

// applyEnvOverrides applies the environment variables on top of the values
// read from the file. The variables exist so a second local instance can run
// from the same configuration file: the port, the database and the uploads
// directory have to differ, and the domain follows from the port.
//
// FASTCHAT_HOST is the bind address (not the identity); FASTCHAT_PUBLIC_DOMAIN
// overrides the identity when the bind address is not reachable from outside.
//
// Secrets never come from YAML alone: FASTCHAT_SMTP_PASSWORD (or
// FASTCHAT_SMTP_PASSWORD_FILE) overrides smtp.password, and
// FASTCHAT_TURN_SECRET (or FASTCHAT_TURN_SECRET_FILE) overrides the secret of
// every configured TURN server. A *_FILE value is a path to a file holding
// the secret (mode 0600); it wins over the plain variable when both are set.
func applyEnvOverrides(cfg *Config) error {
	if host := strings.TrimSpace(os.Getenv("FASTCHAT_HOST")); host != "" {
		cfg.Server.Host = host
	}

	if domain := strings.TrimSpace(os.Getenv("FASTCHAT_PUBLIC_DOMAIN")); domain != "" {
		cfg.Server.PublicDomain = domain
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

	if path := os.Getenv("FASTCHAT_PUSH_KEY_PATH"); path != "" {
		cfg.Push.KeyPath = path
	}

	if path := os.Getenv("FASTCHAT_FEDERATION_KEY_PATH"); path != "" {
		cfg.Federation.KeyPath = path
	}

	// The end-to-end suite registers many accounts from one address in a
	// minute: the limits are configurable so the suite does not trip them.
	for env, limit := range map[string]*RateLimitConfig{
		"FASTCHAT_SEND_CODE_LIMIT":    &cfg.RateLimits.SendCode,
		"FASTCHAT_VERIFY_CODE_LIMIT":  &cfg.RateLimits.VerifyCode,
		"FASTCHAT_REGISTER_LIMIT":     &cfg.RateLimits.Register,
		"FASTCHAT_GENERAL_RATE_LIMIT": &cfg.RateLimits.General,
	} {
		raw := os.Getenv(env)
		if raw == "" {
			continue
		}
		parsed, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || parsed <= 0 {
			return fmt.Errorf("%w: %s=%q", ErrInvalidRateLimit, env, raw)
		}
		limit.Limit = parsed
	}

	if admins := os.Getenv("FASTCHAT_ADMINS"); admins != "" {
		cfg.Server.Admins = splitList(admins)
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

	// Validate after the environment has been applied: FASTCHAT_HOST and
	// FASTCHAT_PUBLIC_DOMAIN write into the same fields, so a typo in a unit
	// file must not reach listen() or the user ids.
	host, err := normalizeServerHost(cfg.Server.Host)
	if err != nil {
		return nil, err
	}
	cfg.Server.Host = host

	if cfg.Server.Port < 1 || cfg.Server.Port > 65535 {
		return nil, fmt.Errorf("%w: got %d", ErrInvalidPort, cfg.Server.Port)
	}

	domain, err := resolveDomain(cfg.Server.Host, cfg.Server.PublicDomain, cfg.Server.Port)
	if err != nil {
		return nil, err
	}
	cfg.Server.Domain = domain

	applyDefaults(&cfg)
	applyICEDefaults(&cfg)

	// Filesystem paths are resolved against the config file directory so the
	// server does not depend on the working directory it was started from.
	resolveConfigPaths(&cfg, filepath.Dir(configPath))

	if err := validateConfig(&cfg); err != nil {
		return nil, err
	}

	listen := net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))

	slog.Info("config loaded",
		"server_domain", cfg.Server.Domain,
		"listen", listen,
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

	if cfg.Auth.MaxSessionsPerUser == 0 {
		cfg.Auth.MaxSessionsPerUser = 50
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

	if auth.MaxSessionsPerUser < 0 {
		return fmt.Errorf("%w: got %d", ErrInvalidMaxSessions, auth.MaxSessionsPerUser)
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
