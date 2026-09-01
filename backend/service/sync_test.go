package service

import (
	"testing"
	"time"
)

func TestParseSince(t *testing.T) {
	// Empty string falls back to the epoch.
	parsed, err := ParseSince("")
	if err != nil {
		t.Fatalf("ParseSince empty: %v", err)
	}

	if !parsed.Equal(time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("empty since should be epoch, got %v", parsed)
	}

	// Valid RFC3339 passes through.
	parsed, err = ParseSince("2026-08-30T10:00:00Z")
	if err != nil {
		t.Fatalf("ParseSince valid: %v", err)
	}

	if parsed.Year() != 2026 || parsed.Month() != time.August {
		t.Errorf("unexpected parsed value: %v", parsed)
	}

	// Malformed timestamps error.
	if _, err := ParseSince("not-a-timestamp"); err == nil {
		t.Error("expected error for malformed since")
	}
}
