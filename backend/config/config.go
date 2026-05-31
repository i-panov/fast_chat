// Package config provides application configuration loaded from environment variables.
package config

import (
	"os"
	"strconv"
)

// Config holds application settings.
type Config struct {
	MessageEditTTL   int
	MessageDeleteTTL int
	ServerDomain     string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	return &Config{
		MessageEditTTL:   getEnvInt("MESSAGE_EDIT_TTL", 300),
		MessageDeleteTTL: getEnvInt("MESSAGE_DELETE_TTL", 0),
		ServerDomain:     getEnv("SERVER_DOMAIN", "localhost:8080"),
	}
}

func getEnv(key, defaultVal string) string {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}

	return val
}

func getEnvInt(key string, defaultVal int) int {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}

	n, err := strconv.Atoi(val)
	if err != nil {
		return defaultVal
	}

	return n
}
