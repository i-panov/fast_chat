// Package turn builds the credentials of the TURN REST API. Coturn started
// with use-auth-secret and a static-auth-secret knows the shared key only:
// every client gets its own name and password, and a password that leaked
// stops working when the call is over.
package turn

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // the hash is fixed by the TURN REST API, not a choice
	"encoding/base64"
	"errors"
	"strconv"
	"time"
)

// CredentialTTL is how long a credential lives. Coturn checks the expiry when
// the client allocates a relayed address, and the allocation outlives the
// check, so the window only has to cover the start of the call.
const CredentialTTL = time.Hour

// Credentials are the name and the password a client uses for the relay.
type Credentials struct {
	Username   string
	Credential string
}

// ErrEmptySecret is returned when the TURN REST API secret is missing: an
// HMAC under an empty key looks valid but lets anyone mint credentials.
var ErrEmptySecret = errors.New("turn secret is empty")

// Generate builds the credentials of the user. Coturn takes the expiry from
// the part of the name before the colon and checks the password against the
// HMAC of the whole name under the shared secret, so the secret itself never
// leaves the server.
//
// An empty secret yields empty credentials instead of an HMAC under an empty
// key; use GenerateChecked when an error is easier to handle than empty.
func Generate(secret, userID string, now time.Time) Credentials {
	creds, err := GenerateChecked(secret, userID, now)
	if err != nil {
		return Credentials{}
	}

	return creds
}

// GenerateChecked is Generate with an explicit error on an empty secret.
func GenerateChecked(secret, userID string, now time.Time) (Credentials, error) {
	if secret == "" {
		return Credentials{}, ErrEmptySecret
	}

	username := strconv.FormatInt(now.Add(CredentialTTL).Unix(), 10) + ":" + userID

	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))

	return Credentials{
		Username:   username,
		Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil)),
	}, nil
}
