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
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"fast_chat/internal/httputil"
)

var (
	ErrUnsafeAddress       = errors.New("refusing to connect to unsafe address")
	ErrNoSafeAddress       = errors.New("no safe address found")
	ErrWellKnownStatus     = errors.New("well-known request returned unexpected status")
	ErrPEMBlockDecode      = errors.New("failed to decode PEM block")
	ErrNotRSAPublicKey     = errors.New("not an RSA public key")
	ErrPrivateKeyPEMDecode = errors.New("failed to decode private key PEM")
	ErrKeyNotRSA           = errors.New("key is not RSA")
)

const (
	wellKnownPath      = "/.well-known/fast-chat"
	privFileName       = "federation.priv"
	pubFileName        = "federation.pub"
	cacheTTL           = 1 * time.Hour
	replayWindow       = 10 * time.Minute
	nonceCleanupTick   = 1 * time.Minute
	timestampTolerance = 5 * time.Minute
	// A well-known document carries one PEM public key, so this is three
	// orders of magnitude more than a real response needs. It exists to bound
	// memory for a peer that streams garbage, not to accommodate large keys.
	maxWellKnownBody = 64 << 10
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

// SetHTTPClient replaces the client used for well-known key fetches.
// Production code never needs it: the default SSRF-safe dialer refuses
// loopback targets, so integration tests that run federation peers on
// httptest loopback servers must inject a client that can reach them.
func (m *Manager) SetHTTPClient(c *http.Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.client = c
}

// New creates a new federation manager.
func New(privateKey *rsa.PrivateKey, serverDomain, scheme string, timeoutSec int) *Manager {
	mgr := &Manager{
		privateKey:    privateKey,
		publicKey:     &privateKey.PublicKey,
		serverDomain:  serverDomain,
		scheme:        scheme,
		client:        NewSafeHTTPClient(time.Duration(timeoutSec) * time.Second),
		pubKeyCache:   make(map[string]*cacheEntry),
		cacheDuration: cacheTTL,
		closeCh:       make(chan struct{}),
	}

	go mgr.cleanupNonces()

	return mgr
}

// NewSafeHTTPClient returns an http.Client whose dialer refuses to
// connect to loopback, private, link-local, unspecified, or multicast
// addresses. This closes the DNS-rebinding SSRF hole: the hostname is
// resolved once, and the connection is dialed to the verified IP
// directly, so a second DNS resolution cannot redirect it.
func NewSafeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
	}

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}

			// IP literal: validate and dial directly.
			if ip := net.ParseIP(host); ip != nil {
				if isUnsafeIP(ip) {
					return nil, fmt.Errorf("%w: %s", ErrUnsafeAddress, ip)
				}

				return dialer.DialContext(ctx, network, addr)
			}

			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}

			// Pick the first safe address and dial it directly. Dialing
			// the verified IP (not the hostname) prevents a second DNS
			// lookup from returning a different, unsafe address.
			for _, ip := range ips {
				if isUnsafeIP(ip.IP) {
					continue
				}

				return dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			}

			return nil, fmt.Errorf("%w: %s", ErrNoSafeAddress, host)
		},
	}

	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

// isUnsafeIP reports whether an IP must never be dialed for federation
// (SSRF protection).
func isUnsafeIP(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() ||
		ip.IsMulticast()
}

// Close stops the manager's background goroutines.
func (m *Manager) Close() {
	close(m.closeCh)
}

// LoadOrGenerateKeys loads an existing RSA key pair or generates a new one.
func LoadOrGenerateKeys(keyDir string) (*rsa.PrivateKey, error) {
	// Directory mode is deliberate least privilege: 0700/0750 gives the owner
	// rwx (or r-x for group) on a directory; anything below strips the execute
	// bit and breaks path traversal. The rule targets file modes.
	// nosemgrep: go.lang.correctness.permissions.incorrect-default-permission
	if err := os.MkdirAll(keyDir, 0o700); err != nil {
		return nil, fmt.Errorf("failed to create key directory: %w", err)
	}

	privPath := filepath.Join(keyDir, privFileName)

	if _, err := os.Stat(privPath); err == nil {
		return loadPrivateKey(privPath)
	}

	slog.Info("generating new federation RSA key pair", "dir", keyDir)

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

	httputil.WriteJSON(w, http.StatusOK, map[string]string{
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
		slog.Warn("failed to fetch .well-known", "server", serverDomain, "err", err)
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

func (m *Manager) fetchWellKnown(ctx context.Context, serverDomain string) (*rsa.PublicKey, error) {
	wellKnownURL := fmt.Sprintf("%s://%s%s", m.scheme, serverDomain, wellKnownPath)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, wellKnownURL, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("well-known request creation failed: %w", err)
	}

	// By design: peers are addressed by domain from X-Federation-Server.
	// NewSafeHTTPClient blocks private/loopback IPs at dial time and pins the
	// resolved IP (DNS-rebinding safe); a forged peer still fails signature
	// verification. codeql[go/request-forgery]
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("well-known request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // body close errors are not actionable

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: %d", ErrWellKnownStatus, resp.StatusCode)
	}

	var data struct {
		PublicKeyPem string `json:"publicKeyPem"`
	}

	// The body is read before the request is authenticated: Verify fetches the
	// peer's key to check the signature, so an anonymous caller naming an
	// arbitrary host in X-Federation-Server reaches this decode with no
	// credential presented and a signature that need not be valid. Cap it so a
	// hostile peer cannot make the server allocate whatever it likes: the
	// payload is a single PEM public key of a few hundred bytes.
	resp.Body = http.MaxBytesReader(nil, resp.Body, maxWellKnownBody)

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, fmt.Errorf("failed to decode well-known response: %w", err)
	}

	return parsePublicKeyPEM(data.PublicKeyPem)
}

func parsePublicKeyPEM(pemStr string) (*rsa.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, ErrPEMBlockDecode
	}

	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}

	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, ErrNotRSAPublicKey
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
		return nil, ErrPrivateKeyPEMDecode
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	priv, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, ErrKeyNotRSA
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
