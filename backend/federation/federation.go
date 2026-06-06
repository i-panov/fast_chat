// Package federation provides RSA-based server-to-server authentication
// for federated chat using the .well-known pattern.
package federation

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	wellKnownPath      = "/.well-known/fast-chat"
	privFileName       = "federation.priv"
	pubFileName        = "federation.pub"
	cacheTTL           = 1 * time.Hour
	replayWindow       = 10 * time.Minute
	nonceCleanupTick   = 1 * time.Minute
	timestampTolerance = 5 * time.Minute
)

type cacheEntry struct {
	key       *rsa.PublicKey
	expiresAt time.Time
}

type nonceEntry struct {
	expiresAt time.Time
}

// Manager handles federation key management, signing, and verification.
type Manager struct {
	privateKey    *rsa.PrivateKey
	publicKey     *rsa.PublicKey
	serverDomain  string
	scheme        string
	client        *http.Client
	mu            sync.RWMutex
	pubKeyCache   map[string]*cacheEntry
	cacheDuration time.Duration
	nonces        sync.Map // key = "serverDomain:signature" → nonceEntry
	closeCh       chan struct{}
}

// ServerDomain returns the local server's domain as configured at startup.
func (m *Manager) ServerDomain() string {
	return m.serverDomain
}

// New creates a new federation manager.
func New(privateKey *rsa.PrivateKey, serverDomain, scheme string, timeoutSec int) *Manager {
	mgr := &Manager{
		privateKey:    privateKey,
		publicKey:     &privateKey.PublicKey,
		serverDomain:  serverDomain,
		scheme:        scheme,
		client:        &http.Client{Timeout: time.Duration(timeoutSec) * time.Second},
		pubKeyCache:   make(map[string]*cacheEntry),
		cacheDuration: cacheTTL,
		closeCh:       make(chan struct{}),
	}

	go mgr.cleanupNonces()

	return mgr
}

// Close stops the manager's background goroutines.
func (m *Manager) Close() {
	close(m.closeCh)
}

// LoadOrGenerateKeys loads an existing RSA key pair or generates a new one.
func LoadOrGenerateKeys(keyDir string) (*rsa.PrivateKey, error) {
	if err := os.MkdirAll(keyDir, 0o750); err != nil {
		return nil, fmt.Errorf("failed to create key directory: %w", err)
	}

	privPath := filepath.Join(keyDir, privFileName)

	if _, err := os.Stat(privPath); err == nil {
		return loadPrivateKey(privPath)
	}

	log.Printf("Generating new federation RSA key pair in %s", keyDir)

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("failed to generate RSA key: %w", err)
	}

	if err := savePrivateKey(filepath.Join(keyDir, privFileName), privateKey); err != nil {
		return nil, err
	}

	if err := savePublicKey(filepath.Join(keyDir, pubFileName), &privateKey.PublicKey); err != nil {
		return nil, err
	}

	return privateKey, nil
}

// Sign creates a base64-encoded RSA-SHA256 signature for the given request
// data. The signature covers the sender's serverDomain so that a signature
// minted for server A cannot be replayed by an attacker claiming to be server
// B over the same request.
//
// serverDomain is the caller's own server domain (e.g. "chat.example.com").
func (m *Manager) Sign(method, requestURI string, body []byte, timestamp int64) (string, error) {
	data := signedPayload(m.serverDomain, method, requestURI, body, timestamp)
	hash := sha256.Sum256([]byte(data))

	sig, err := rsa.SignPKCS1v15(rand.Reader, m.privateKey, crypto.SHA256, hash[:])
	if err != nil {
		return "", fmt.Errorf("federation sign: %w", err)
	}

	return base64.StdEncoding.EncodeToString(sig), nil
}

// Verify checks the RSA signature against the remote server's public key
// and rejects replays. serverDomain is the asserted sender identity (the
// value of the X-Federation-Server header) and must match the domain the
// signature was minted for.
func (m *Manager) Verify(ctx context.Context, serverDomain, signature, method, requestURI string, body []byte, timestamp int64) bool {
	if !m.timestampFresh(timestamp) {
		return false
	}

	publicKey := m.getPublicKey(ctx, serverDomain)
	if publicKey == nil {
		return false
	}

	sigBytes, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}

	data := signedPayload(serverDomain, method, requestURI, body, timestamp)
	hash := sha256.Sum256([]byte(data))

	if rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, hash[:], sigBytes) != nil {
		return false
	}

	return m.markNonceFresh(serverDomain, signature)
}

func (m *Manager) timestampFresh(ts int64) bool {
	now := time.Now().Unix()

	delta := now - ts
	if delta < 0 {
		delta = -delta
	}

	return delta <= int64(timestampTolerance.Seconds())
}

func (m *Manager) markNonceFresh(serverDomain, signature string) bool {
	key := serverDomain + ":" + signature
	entry := nonceEntry{expiresAt: time.Now().Add(replayWindow)}

	if _, loaded := m.nonces.LoadOrStore(key, entry); loaded {
		// We've seen this exact (server, signature) pair before. Even if
		// the prior entry is technically past its expiry (clock skew,
		// slow cleanup tick), a duplicate signature is never legitimate
		// during the freshness window.
		return false
	}

	return true
}

func (m *Manager) cleanupNonces() {
	ticker := time.NewTicker(nonceCleanupTick)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			now := time.Now()

			m.nonces.Range(func(k, v any) bool {
				entry := v.(nonceEntry) //nolint:errcheck // invariant: only nonceEntry is stored
				if now.After(entry.expiresAt) {
					m.nonces.Delete(k)
				}

				return true
			})

		case <-m.closeCh:
			return
		}
	}
}

// signedPayload builds the byte string that is hashed and signed. The
// pipe-separated layout makes accidental collisions between (method, path,
// body) tuples vanishingly unlikely and is unambiguous to reconstruct.
func signedPayload(serverDomain, method, requestURI string, body []byte, timestamp int64) string {
	var buf strings.Builder
	buf.Grow(len(serverDomain) + len(method) + len(requestURI) + len(body) + 32)
	buf.WriteString(serverDomain)
	buf.WriteByte('|')
	buf.WriteString(method)
	buf.WriteByte('|')
	buf.WriteString(requestURI)
	buf.WriteByte('|')
	buf.Write(body)
	buf.WriteByte('|')
	buf.WriteString(strconv.FormatInt(timestamp, 10))

	return buf.String()
}

// WellKnownHandler handles GET /.well-known/fast-chat requests.
func (m *Manager) WellKnownHandler(w http.ResponseWriter, _ *http.Request) {
	pemStr, err := m.publicKeyPEM()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"serverDomain": m.serverDomain,
		"publicKeyPem": pemStr,
	})
}

// PublicKeyPEM returns the public key in PEM format.
func (m *Manager) PublicKeyPEM() (string, error) {
	return m.publicKeyPEM()
}

func (m *Manager) publicKeyPEM() (string, error) {
	pubBytes, err := x509.MarshalPKIXPublicKey(m.publicKey)
	if err != nil {
		return "", err
	}

	pemData := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubBytes,
	})

	return string(pemData), nil
}

func (m *Manager) getPublicKey(ctx context.Context, serverDomain string) *rsa.PublicKey {
	if serverDomain == m.serverDomain {
		return m.publicKey
	}

	m.mu.RLock()
	entry, ok := m.pubKeyCache[serverDomain]
	m.mu.RUnlock()

	if ok && time.Now().Before(entry.expiresAt) {
		return entry.key
	}

	key, err := m.fetchWellKnown(ctx, serverDomain)
	if err != nil {
		log.Printf("Failed to fetch .well-known from %s: %v", serverDomain, err) //nolint:gosec // serverDomain from X-Federation-Server header
		return nil
	}

	m.mu.Lock()
	m.pubKeyCache[serverDomain] = &cacheEntry{
		key:       key,
		expiresAt: time.Now().Add(m.cacheDuration),
	}
	m.mu.Unlock()

	return key
}

func (m *Manager) fetchWellKnown(ctx context.Context, serverDomain string) (*rsa.PublicKey, error) {
	wellKnownURL := fmt.Sprintf("%s://%s%s", m.scheme, serverDomain, wellKnownPath)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, wellKnownURL, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("well-known request creation failed: %w", err)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("well-known request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // body close errors are not actionable

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("well-known returned %d", resp.StatusCode)
	}

	var data struct {
		PublicKeyPem string `json:"publicKeyPem"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, fmt.Errorf("failed to decode well-known response: %w", err)
	}

	return parsePublicKeyPEM(data.PublicKeyPem)
}

func parsePublicKeyPEM(pemStr string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("failed to decode PEM block")
	}

	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}

	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("not an RSA public key")
	}

	return rsaPub, nil
}

func loadPrivateKey(path string) (*rsa.PrivateKey, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path is a controlled key file path from FederationKeyPath config
	if err != nil {
		return nil, err
	}

	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("failed to decode private key PEM")
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	priv, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("key is not RSA")
	}

	return priv, nil
}

func savePrivateKey(path string, key *rsa.PrivateKey) error {
	privBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}

	pemData := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: privBytes,
	})

	return os.WriteFile(path, pemData, 0o600)
}

func savePublicKey(path string, key *rsa.PublicKey) error {
	pubBytes, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return err
	}

	pemData := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubBytes,
	})

	return os.WriteFile(path, pemData, 0o644) //nolint:gosec // public key is public
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("federation writeJSON: %v", err)
	}
}
