// Package ids generates the random identifiers used across the server. It
// lives apart from the store so that packages without a database dependency
// (the call registry) can use it too.
package ids

import (
	"crypto/rand"
	"encoding/hex"
)

// Generate returns a random 128-bit identifier in hex.
func Generate() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}
