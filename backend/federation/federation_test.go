package federation

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestManager(t *testing.T, serverDomain string) *Manager {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	m := New(key, serverDomain, "http", 5, false)
	t.Cleanup(m.Close)

	return m
}

// testNonce is the nonce the tests sign their requests with.
const testNonce = "test-nonce"

func mustSign(t *testing.T, m *Manager, audience, method, requestURI string, body []byte, ts int64) string {
	t.Helper()

	sig, err := m.Sign(audience, method, requestURI, body, ts, testNonce)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	return sig
}

func TestServerDomain(t *testing.T) {
	m := newTestManager(t, "chat.example.com")
	if got := m.ServerDomain(); got != "chat.example.com" {
		t.Fatalf("ServerDomain() = %q, want %q", got, "chat.example.com")
	}
}

func TestSignVerifyRoundtrip(t *testing.T) {
	m := newTestManager(t, "local.test")

	// Wire the remote manager's public key into the local cache so Verify
	// uses it without a network round-trip to /.well-known/fast-chat.
	remote := "remote.test"
	other := newTestManager(t, remote)
	m.cachePublicKey(remote, other.publicKey, time.Hour)

	ts := time.Now().Unix()
	body := []byte(`{"hello":"world"}`)
	sig := mustSign(t, other, "local.test", http.MethodPost, "/api/federated/messages", body, ts)

	if !m.Verify(context.Background(), remote, sig, http.MethodPost, "/api/federated/messages", body, ts, testNonce) {
		t.Fatal("Verify returned false for a freshly signed payload")
	}
}

func TestVerifyRejectsWrongServer(t *testing.T) {
	m := newTestManager(t, "local.test")

	// Sign with one manager (domain A) but verify under a different
	// asserted sender identity (domain B) using a key unrelated to A.
	other := newTestManager(t, "remote-a.test")
	bystanderKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	m.cachePublicKey("remote-b.test", &bystanderKey.PublicKey, time.Hour)

	ts := time.Now().Unix()
	body := []byte("payload")
	sig := mustSign(t, other, "local.test", http.MethodPost, "/x", body, ts)

	if m.Verify(context.Background(), "remote-b.test", sig, http.MethodPost, "/x", body, ts, testNonce) {
		t.Fatal("Verify accepted a signature minted for a different server")
	}
}

func TestVerifyRejectsTamperedBody(t *testing.T) {
	m := newTestManager(t, "local.test")

	other := newTestManager(t, "remote.test")
	m.cachePublicKey("remote.test", other.publicKey, time.Hour)

	ts := time.Now().Unix()
	sig := mustSign(t, other, "local.test", http.MethodPost, "/x", []byte("original"), ts)

	if m.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", []byte("tampered"), ts, testNonce) {
		t.Fatal("Verify accepted a signature over a tampered body")
	}
}

func TestVerifyRejectsExpiredTimestamp(t *testing.T) {
	m := newTestManager(t, "local.test")

	other := newTestManager(t, "remote.test")
	m.cachePublicKey("remote.test", other.publicKey, time.Hour)

	old := time.Now().Add(-2 * time.Hour).Unix()
	sig := mustSign(t, other, "local.test", http.MethodPost, "/x", nil, old)

	if m.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", nil, old, testNonce) {
		t.Fatal("Verify accepted a signature with an old timestamp")
	}
}

func TestVerifyRejectsFutureTimestamp(t *testing.T) {
	m := newTestManager(t, "local.test")

	other := newTestManager(t, "remote.test")
	m.cachePublicKey("remote.test", other.publicKey, time.Hour)

	future := time.Now().Add(2 * time.Hour).Unix()
	sig := mustSign(t, other, "local.test", http.MethodPost, "/x", nil, future)

	if m.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", nil, future, testNonce) {
		t.Fatal("Verify accepted a signature with a future timestamp")
	}
}

func TestVerifyRejectsReplay(t *testing.T) {
	m := newTestManager(t, "local.test")

	other := newTestManager(t, "remote.test")
	m.cachePublicKey("remote.test", other.publicKey, time.Hour)

	ts := time.Now().Unix()
	body := []byte("hello")
	sig := mustSign(t, other, "local.test", http.MethodPost, "/x", body, ts)

	if !m.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", body, ts, testNonce) {
		t.Fatal("first Verify call should succeed")
	}

	if m.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", body, ts, testNonce) {
		t.Fatal("Verify accepted the exact same signature twice (replay)")
	}
}

func TestVerifyRejectsUnknownServer(t *testing.T) {
	m := newTestManager(t, "local.test")

	ts := time.Now().Unix()
	sig := "not-a-real-signature"

	if m.Verify(context.Background(), "unknown.test", sig, http.MethodPost, "/x", nil, ts, testNonce) {
		t.Fatal("Verify succeeded for an unknown server with garbage signature")
	}
}

func TestVerifyRejectsMalformedSignature(t *testing.T) {
	m := newTestManager(t, "local.test")

	other := newTestManager(t, "remote.test")
	m.cachePublicKey("remote.test", other.publicKey, time.Hour)

	ts := time.Now().Unix()
	if m.Verify(context.Background(), "remote.test", "not-base64!@#$", http.MethodPost, "/x", nil, ts, testNonce) {
		t.Fatal("Verify accepted a malformed base64 signature")
	}
}

func TestPublicKeyPEMRoundtrip(t *testing.T) {
	mgr := newTestManager(t, "local.test")

	pemStr, err := mgr.PublicKeyPEM()
	if err != nil {
		t.Fatalf("PublicKeyPEM: %v", err)
	}

	parsed, err := parsePublicKeyPEM(pemStr)
	if err != nil {
		t.Fatalf("parsePublicKeyPEM: %v", err)
	}

	if parsed == nil {
		t.Fatal("parsePublicKeyPEM returned nil key")
	}

	// Sign a payload with mgr's own private key and verify it directly
	// with the re-parsed public key. This proves the roundtrip preserves
	// a usable key pair end-to-end.
	data := []byte("payload")
	hash := sha256.Sum256(data)

	sig, err := rsa.SignPKCS1v15(rand.Reader, mgr.privateKey, crypto.SHA256, hash[:])
	if err != nil {
		t.Fatal(err)
	}

	if err := rsa.VerifyPKCS1v15(parsed, crypto.SHA256, hash[:], sig); err != nil {
		t.Fatalf("parsed key failed to verify original signature: %v", err)
	}
}

func TestParsePublicKeyPEMRejectsGarbage(t *testing.T) {
	cases := []string{
		"",
		"not a pem block",
		"-----BEGIN RSA PUBLIC KEY-----\n-----END RSA PUBLIC KEY-----\n",
	}
	for _, in := range cases {
		if _, err := parsePublicKeyPEM(in); err == nil {
			t.Errorf("parsePublicKeyPEM(%q) returned nil error, want error", in)
		}
	}
}

// cachePublicKey seeds the manager's pubKeyCache for tests so we don't
// have to spin up a /.well-known server.
func (m *Manager) cachePublicKey(domain string, key *rsa.PublicKey, ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pubKeyCache[domain] = &cacheEntry{key: key, expiresAt: time.Now().Add(ttl)}
}

// TestWellKnownHandler ensures the embedded http handler exposes the
// public key when a known server requests it.
func TestWellKnownHandler(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	m := New(key, "local.test", "http", 5, false)
	t.Cleanup(m.Close)

	pemStr, err := m.PublicKeyPEM()
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequestWithContext(context.Background(), http.MethodGet, wellKnownPath, http.NoBody)
	rec := httptest.NewRecorder()
	m.WellKnownHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		ServerDomain string `json:"serverDomain"`
		PublicKeyPem string `json:"publicKeyPem"`
	}

	if err := json.NewDecoder(bytes.NewReader(rec.Body.Bytes())).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if body.ServerDomain != "local.test" {
		t.Errorf("serverDomain = %q, want %q", body.ServerDomain, "local.test")
	}

	if body.PublicKeyPem != pemStr {
		t.Errorf("publicKeyPem mismatch")
	}
}

func TestVerifyRejectsCrossServerReplay(t *testing.T) {
	sender := newTestManager(t, "remote.test")
	a := newTestManager(t, "a.test")
	b := newTestManager(t, "b.test")
	a.cachePublicKey("remote.test", sender.publicKey, time.Hour)
	b.cachePublicKey("remote.test", sender.publicKey, time.Hour)

	ts := time.Now().Unix()
	body := []byte("hello")
	sig := mustSign(t, sender, "a.test", http.MethodPost, "/x", body, ts)

	if !a.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", body, ts, testNonce) {
		t.Fatal("Verify at the intended recipient should succeed")
	}

	// Same bytes, same sender, different recipient: a forward of A's request
	// to B must not verify.
	if b.Verify(context.Background(), "remote.test", sig, http.MethodPost, "/x", body, ts, "other-nonce") {
		t.Fatal("Verify accepted a signature minted for another recipient")
	}
}

func TestIsValidFederationDomain(t *testing.T) {
	valid := []string{
		"example.com",
		"chat.example.com",
		"example.com:8443",
		"127.0.0.1:8080",
		"10.0.0.1:8080",
		"[::1]:8080",
		"peer.test",
	}
	for _, d := range valid {
		if !isValidFederationDomain(d) {
			t.Errorf("isValidFederationDomain(%q) = false, want true", d)
		}
	}

	invalid := []string{
		"",
		"not a domain",
		"peer/@evil",
		"peer?x=1",
		"peer#frag",
		"user@peer.test",
		"peer.test/path",
		"x:127.0.0.1:9000",
		"peer.test:99999",
		"peer.test:",
		"peer_test.com",
		"a\r\nb",
	}
	for _, d := range invalid {
		if isValidFederationDomain(d) {
			t.Errorf("isValidFederationDomain(%q) = true, want false", d)
		}
	}
}

func TestManagerCloseIsIdempotent(t *testing.T) {
	m := newTestManager(t, "local.test")
	m.Close()
	m.Close()
}

func TestVerifyNegativeCacheShortCircuitsFetch(t *testing.T) {
	m := newTestManager(t, "local.test")

	ts := time.Now().Unix()
	if m.Verify(context.Background(), "missing.invalid", "sig", http.MethodPost, "/x", nil, ts, testNonce) {
		t.Fatal("Verify with an unresolvable domain should fail")
	}

	m.mu.RLock()
	_, negOk := m.negCache["missing.invalid"]
	m.mu.RUnlock()

	if !negOk {
		t.Fatal("a failed fetch should populate the negative cache")
	}

	// Second call must fail without another fetch: point the client at a
	// transport that panics if used.
	m.SetHTTPClient(&http.Client{Transport: roundTripPanic{}})

	if m.Verify(context.Background(), "missing.invalid", "sig", http.MethodPost, "/x", nil, ts, "nonce-2") {
		t.Fatal("negative-cached Verify should fail without fetching")
	}
}

type roundTripPanic struct{}

func (roundTripPanic) RoundTrip(_ *http.Request) (*http.Response, error) {
	panic("negative cache was bypassed: fetch attempted")
}

func TestNonceMapIsCapped(t *testing.T) {
	m := newTestManager(t, "local.test")
	m.nonceCount.Store(maxNonces)

	if m.markNonceFresh("remote.test", "sig") {
		t.Fatal("markNonceFresh past the cap should refuse")
	}
}
