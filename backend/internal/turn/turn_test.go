package turn

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGenerate(t *testing.T) {
	// The expiry is the part coturn reads before the colon, and the password
	// is the base64 of its HMAC-SHA1 under the secret (the value comes from
	// openssl, so a change of the algorithm cannot pass unnoticed).
	const expiry = 1_700_000_000

	now := time.Unix(expiry, 0).Add(-CredentialTTL)

	got := Generate("s3cret", "alice:localhost:8080", now)

	if got.Username != "1700000000:alice:localhost:8080" {
		t.Fatalf("username = %q", got.Username)
	}

	if got.Credential != "OM8aAa7aYPUcLs+mMcypDMpUV58=" {
		t.Fatalf("credential = %q", got.Credential)
	}

	stamp, _, ok := strings.Cut(got.Username, ":")
	if !ok {
		t.Fatalf("the name has no expiry: %q", got.Username)
	}

	expires, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil {
		t.Fatalf("the expiry is not a number: %v", err)
	}

	if expires != expiry {
		t.Fatalf("expiry = %d, want %d", expires, expiry)
	}
}

func TestGenerateUsesTheSecret(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)

	if Generate("one", "alice", now) == Generate("two", "alice", now) {
		t.Fatal("the credential does not depend on the secret")
	}
}

func TestGenerateCheckedRejectsEmptySecret(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)

	if _, err := GenerateChecked("", "alice", now); err == nil {
		t.Fatal("expected error for empty secret, got nil")
	}

	if got := Generate("", "alice", now); got != (Credentials{}) {
		t.Fatalf("Generate with empty secret = %+v, want empty credentials", got)
	}
}
