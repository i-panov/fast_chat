package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

// PublicKeyLen is the X25519 key size in bytes (libsodium
// crypto_box_PUBLICKEYBYTES).
const PublicKeyLen = 32

// ErrInvalidPublicKey is returned when a public key cannot be decoded or has
// the wrong length.
var ErrInvalidPublicKey = errors.New("invalid public key")

// DecodePublicKey accepts any common base64 variant and returns the raw key.
// The frontend encodes keys with libsodium, whose default is URLSAFE_NO_PADDING
// ("-" and "_" instead of "+" and "/", no padding); standard variants are
// accepted too for robustness. The key must decode to exactly PublicKeyLen bytes.
func DecodePublicKey(key string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}

	for _, enc := range encodings {
		raw, err := enc.DecodeString(key)
		if err == nil && len(raw) == PublicKeyLen {
			return raw, nil
		}
	}

	return nil, ErrInvalidPublicKey
}

// KeyVersionFor derives a short fingerprint from the public key so clients can
// detect a changed key and refresh their cache.
func KeyVersionFor(publicKey string) string {
	sum := sha256.Sum256([]byte(publicKey))

	return hex.EncodeToString(sum[:6])
}
