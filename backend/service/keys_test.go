package service

import (
	"encoding/base64"
	"errors"
	"testing"
)

func TestDecodePublicKey(t *testing.T) {
	raw := make([]byte, PublicKeyLen)
	for i := range raw {
		raw[i] = byte(i)
	}

	stdEncoded := base64.StdEncoding.EncodeToString(raw)
	urlEncoded := base64.URLEncoding.EncodeToString(raw)
	stdRaw := base64.RawStdEncoding.EncodeToString(raw)
	urlRaw := base64.RawURLEncoding.EncodeToString(raw)

	for _, input := range []string{stdEncoded, urlEncoded, stdRaw, urlRaw} {
		got, err := DecodePublicKey(input)
		if err != nil {
			t.Errorf("DecodePublicKey(%q) err: %v", input, err)
			continue
		}

		if len(got) != PublicKeyLen {
			t.Errorf("DecodePublicKey(%q) len = %d, want %d", input, len(got), PublicKeyLen)
		}
	}

	// Wrong length is rejected.
	short := base64.StdEncoding.EncodeToString([]byte("short"))
	if _, err := DecodePublicKey(short); !errors.Is(err, ErrInvalidPublicKey) {
		t.Errorf("short key: expected ErrInvalidPublicKey, got %v", err)
	}

	// Garbage is rejected.
	if _, err := DecodePublicKey("!!!not-base64!!!"); !errors.Is(err, ErrInvalidPublicKey) {
		t.Errorf("garbage: expected ErrInvalidPublicKey, got %v", err)
	}
}

func TestKeyVersionFor(t *testing.T) {
	v1 := KeyVersionFor("alice-key")
	v2 := KeyVersionFor("alice-key")
	v3 := KeyVersionFor("bob-key")

	if v1 != v2 {
		t.Errorf("KeyVersionFor not deterministic: %q != %q", v1, v2)
	}

	if v1 == v3 {
		t.Error("different keys produced the same version")
	}

	if len(v1) != 12 { // hex of 6 bytes
		t.Errorf("version len = %d, want 12", len(v1))
	}
}
