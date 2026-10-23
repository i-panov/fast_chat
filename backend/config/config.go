// Package config provides configuration loading from YAML files.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	ErrDatabasePathRequired = errors.New("database.path is required")
	ErrServerHostRequired   = errors.New("server.host is required")
)

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
func applyEnvOverrides(cfg *Config) {
	if host := os.Getenv("FASTCHAT_HOST"); host != "" {
		cfg.Server.Host = host
	}

	if port := os.Getenv("FASTCHAT_PORT"); port != "" {
		if parsed, err := strconv.Atoi(port); err == nil && parsed > 0 {
			cfg.Server.Port = parsed
		}
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
	applyEnvOverrides(&cfg)

	cfg.Server.Domain = net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))
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
		cfg.Federation.Scheme = "https"
	}

	if cfg.Federation.Timeout == 0 {
		cfg.Federation.Timeout = 10
	}

	if cfg.RateLimits.General.Limit == 0 {
		cfg.RateLimits.General.Limit = 600
	}

	if cfg.RateLimits.General.Window == 0 {
		cfg.RateLimits.General.Window = time.Minute
	}

	if cfg.RateLimits.SendCode.Limit == 0 {
		cfg.RateLimits.SendCode.Limit = 5
	}

	if cfg.RateLimits.SendCode.Window == 0 {
		cfg.RateLimits.SendCode.Window = time.Minute
	}

	if cfg.RateLimits.VerifyCode.Limit == 0 {
		cfg.RateLimits.VerifyCode.Limit = 10
	}

	if cfg.RateLimits.VerifyCode.Window == 0 {
		cfg.RateLimits.VerifyCode.Window = time.Minute
	}

	if cfg.RateLimits.Register.Limit == 0 {
		cfg.RateLimits.Register.Limit = 5
	}

	if cfg.RateLimits.Register.Window == 0 {
		cfg.RateLimits.Register.Window = 10 * time.Minute
	}

	applyICEDefaults(&cfg)

	return &cfg, nil
}
