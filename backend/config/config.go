// Package config provides application configuration loaded from environment variables.
package config

import (
	"log"
	"os"
	"strconv"
)

// Config holds application settings.
type Config struct {
	DBPath            string
	UploadDir         string
	MessageEditTTL    int
	MessageDeleteTTL  int
	ServerDomain      string
	CORSOrigin        string
	FederationScheme  string
	FederationTimeout int
	FederationKeyPath string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	return &Config{
		DBPath:            getEnv("DB_PATH", "data/fast_chat.db"),
		UploadDir:         getEnv("UPLOAD_DIR", "./data/uploads"),
		MessageEditTTL:    getEnvInt("MESSAGE_EDIT_TTL", 300),
		MessageDeleteTTL:  getEnvInt("MESSAGE_DELETE_TTL", 0),
		ServerDomain:      getEnv("SERVER_DOMAIN", "localhost:8080"),
		CORSOrigin:        getEnv("CORS_ORIGIN", "*"),
		FederationScheme:  getEnv("FEDERATION_SCHEME", "https"),
		FederationTimeout: getEnvInt("FEDERATION_TIMEOUT", 10),
		FederationKeyPath: getEnv("FEDERATION_KEY_PATH", "keys"),
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

	num, err := strconv.Atoi(val)
	if err != nil {
		log.Printf("warn: invalid value %q for %s, using default %d", val, key, defaultVal) //nolint:gosec // controlled environment variable

		return defaultVal
	}

	return num
}
