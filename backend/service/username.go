package service

import (
	"regexp"
	"strings"
)

var usernameBodyRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$`)

// NormalizeUsername lowercases and validates a shared user/bot username body.
// The bot suffix is checked separately by ParseBotUsername.
func NormalizeUsername(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) < usernameMinRunes || len(value) > usernameMaxRunes {
		return "", false
	}
	if strings.Contains(value, "__") || strings.HasSuffix(value, "_") {
		return "", false
	}
	return value, usernameBodyRE.MatchString(value)
}
