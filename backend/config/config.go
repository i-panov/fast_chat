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
}

type ServerConfig struct {
	Host      string `yaml:"host"`
	Port      int    `yaml:"port"`
	Domain    string `yaml:"-"` // computed from Host + Port
	StaticDir string `yaml:"static_dir"`
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
		return nil, errors.New("database.path is required")
	}

	if cfg.Server.Host == "" {
		return nil, errors.New("server.host is required")
	}

	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8080
	}

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
		cfg.RateLimits.General.Limit = 100
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

	return &cfg, nil
}
