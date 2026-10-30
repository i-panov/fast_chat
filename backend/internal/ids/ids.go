// Package ids generates the random identifiers used across the server. It
// lives apart from the store so that packages without a database dependency
// (the call registry) can use it too.
package ids

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

var fallbackCounter atomic.Uint32

// Generate returns a random 128-bit identifier in hex.
//
// It never panics: crypto/rand essentially never fails, but a transient
// entropy error must not take the whole process down, so the fallback below
// mixes time, pid and an atomic counter and still returns 32 hex chars.
func Generate() string {
	id, err := TryGenerate()
	if err == nil {
		return id
	}

	return fallbackID()
}

// TryGenerate returns a random 128-bit identifier or the entropy error.
func TryGenerate() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("crypto/rand.Read: %w", err)
	}

	return hex.EncodeToString(buf), nil
}

// MustGenerate returns a random identifier and panics on entropy failure.
// Prefer Generate or TryGenerate; this exists for init-time code that cannot
// proceed without strong randomness.
func MustGenerate() string {
	id, err := TryGenerate()
	if err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return id
}

// fallbackID builds a best-effort 128-bit hex identifier without entropy by
// hashing time, pid and a counter. It only runs on the crypto/rand error path.
func fallbackID() string {
	seed := strconv.FormatInt(time.Now().UnixNano(), 10) + "|" +
		strconv.Itoa(os.Getpid()) + "|" +
		strconv.FormatUint(uint64(fallbackCounter.Add(1)), 10)

	sum := sha256.Sum256([]byte(seed))

	return hex.EncodeToString(sum[:16])
}
