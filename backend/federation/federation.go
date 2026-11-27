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
	"sync/atomic"
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
	// ErrInvalidFederationDomain marks a server domain that is not a bare
	// host with an optional numeric port.
	ErrInvalidFederationDomain = errors.New("invalid federation server domain")
	ErrNoCommonProtocol        = errors.New("no common federation protocol")
)

const (
	// NonceHeader carries the random value that makes every signed request
	// unique.
	NonceHeader = "X-Federation-Nonce"

	wellKnownPath  = "/.well-known/fast-chat"
	ProtocolHeader = "X-Federation-Protocol"
	// CurrentProtocolVersion is the version this server speaks. Version 2
	// marks the E2EE v3 break: encrypted messages from a v1 peer cannot be
	// read, so plain v1 federation is refused explicitly instead of silently
	// dropping ciphertext.
	CurrentProtocolVersion = 2
	privFileName           = "federation.priv"
	pubFileName            = "federation.pub"
	cacheTTL               = 1 * time.Hour
	negCacheTTL            = 5 * time.Minute
	replayWindow           = 10 * time.Minute
	nonceCleanupTick       = 1 * time.Minute
	timestampTolerance     = 5 * time.Minute
	// maxNonces caps the replay-protection map: every (server:signature)
	// pair lives 10 minutes, so a hostile peer naming fresh nonces could
	// otherwise grow the sync.Map without bound. Past the cap Verify
	// refuses, which fails closed under flood.
	//
	// The cap is 100x the per-peer share on purpose: a sybil that fills its
	// own shares with a few domains must not reach the global cap and deny
	// Verify to every honest peer. Before refusing, the map is swept for
	// entries that are already past the replay window.
	maxNonces = 1000000
	// maxNoncesPerServer bounds one peer's share of the nonce map: without
	// it a single hostile peer could eat the global cap and deny Verify to
	// every legitimate peer until the cleanup tick. Rejected excess counts
	// as failed verification for that peer only.
	maxNoncesPerServer = 10000
	// A well-known document carries one PEM public key, so this is three
	// orders of magnitude more than a real response needs. It exists to bound
	// memory for a peer that streams garbage, not to accommodate large keys.
	maxWellKnownBody = 64 << 10
)

type cacheEntry struct {
	key       *rsa.PublicKey
	versions  []int
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
	// negCache remembers domains whose .well-known fetch recently failed,
	// so a flood of requests naming random domains cannot turn every Verify
	// into a DNS+HTTP round-trip (DoS amplification).
	negCache   map[string]time.Time
	nonces     sync.Map // key = "serverDomain:signature" → nonceEntry
	nonceCount atomic.Int64
	// noncePerServer tracks live entries per peer under mu, so one peer
	// cannot starve the rest of the global cap.
	noncePerServer map[string]int64
	// pinnedKeys remembers the first key seen for every peer (TOFU
	// pinning). A later fetch that returns a different key is refused: a
	// compromised DNS or a hostile well-known server must not be able to
	// replace a peer's identity under the same domain. Rotation therefore
	// needs an explicit restart after the new key is verified out of band.
	pinnedKeys map[string]*rsa.PublicKey
	closeCh    chan struct{}
	closeOnce  sync.Once
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
func New(privateKey *rsa.PrivateKey, serverDomain, scheme string, timeoutSec int, allowPrivate bool) *Manager {
	mgr := &Manager{
		privateKey:     privateKey,
		publicKey:      &privateKey.PublicKey,
		serverDomain:   serverDomain,
		scheme:         scheme,
		client:         NewSafeHTTPClient(time.Duration(timeoutSec)*time.Second, allowPrivate),
		pubKeyCache:    make(map[string]*cacheEntry),
		negCache:       make(map[string]time.Time),
		noncePerServer: make(map[string]int64),
		pinnedKeys:     make(map[string]*rsa.PublicKey),
		cacheDuration:  cacheTTL,
		closeCh:        make(chan struct{}),
	}

	go mgr.cleanupNonces()

	return mgr
}

// fallbackHTTPClient is used only when no client was injected (tests, or a
// zero-value struct). It still dials through the SSRF-safe transport: a nil
// client must never mean an unrestricted one.
func fallbackHTTPClient() *http.Client {
	client := NewSafeHTTPClient(0, false)
	client.CheckRedirect = noCrossHostRedirect
	return client
}

// NewSafeHTTPClient returns an http.Client whose dialer refuses to
// connect to loopback, private, link-local, unspecified, or multicast
// addresses. This closes the DNS-rebinding SSRF hole: the hostname is
// resolved once, and the connection is dialed to the verified IP
// directly, so a second DNS resolution cannot redirect it.
//
// allowPrivate lifts the restriction. It exists for the local setup, where
// the peers run on the loopback interface and the federation would otherwise
// not work at all. It must stay off in production.
func NewSafeHTTPClient(timeout time.Duration, allowPrivate bool) *http.Client {
	dialer := &net.Dialer{
		Timeout:   timeout,
		KeepAlive: 30 * time.Second,
	}

	transport := &http.Transport{
		// No proxy for federation: with ProxyFromEnvironment the SSRF
		// dialer would vet the proxy's address instead of the peer's,
		// and X-Federation-Server fetches would leave the checked path.
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}

			// IP literal: validate and dial directly.
			if ip := net.ParseIP(host); ip != nil {
				if !allowPrivate && isUnsafeIP(ip) {
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
				if !allowPrivate && isUnsafeIP(ip.IP) {
					continue
				}

				return dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			}

			return nil, fmt.Errorf("%w: %s", ErrNoSafeAddress, host)
		},
	}

	// nosemgrep: fast-chat-inline-http-client -- this is the safe constructor.
	return &http.Client{
		Timeout:       timeout,
		Transport:     transport,
		CheckRedirect: noCrossHostRedirect,
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

// Close stops the manager's background goroutines. It is safe to call more
// than once, so two shutdown paths reaching it cannot panic on an already
// closed channel.
func (m *Manager) Close() {
	m.closeOnce.Do(func() {
		close(m.closeCh)
	})
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
// data. The signature covers the sender's serverDomain and the intended
// recipient (audience), so a signature minted for server A cannot be replayed
// by A against server B within the freshness window (cross-server replay).
//
// serverDomain is the caller's own server domain (e.g. "chat.example.com").
// audience is the recipient's domain (the host the request is sent to).
//
// Compatibility: the audience is part of the signed payload, so peers
// running a build without it reject these signatures and vice versa. All
// peers speak the same codebase — upgrade them together; a mixed fleet
// drops federation both ways until the rollout completes. There is no
// negotiation because there is no other implementation of this protocol.
//
// nonce makes every request unique: without it two identical requests within
// the same second would share a signature, and the second one would be
// refused as a replay of the first.
func (m *Manager) Sign(audience, method, requestURI string, body []byte, timestamp int64, nonce string) (string, error) {
	data := signedPayload(m.serverDomain, audience, method, requestURI, body, timestamp, nonce)
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
// signature was minted for. The expected recipient is this manager's own
// domain: a signature minted for another server does not verify here.
func (m *Manager) Verify(ctx context.Context, serverDomain, signature, method, requestURI string, body []byte, timestamp int64, nonce string) bool {
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

	data := signedPayload(serverDomain, m.serverDomain, method, requestURI, body, timestamp, nonce)
	hash := sha256.Sum256([]byte(data))

	if rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, hash[:], sigBytes) != nil {
		return false
	}

	return m.markNonceFresh(serverDomain, signature)
}

// signedPayload builds the byte string that is hashed and signed. The
// pipe-separated layout makes accidental collisions between (method, path,
// body) tuples vanishingly unlikely and is unambiguous to reconstruct.
//
// The nonce is part of the payload, so it cannot be swapped after the fact:
// the signature only verifies for the nonce that was sent with it.
// The audience binds the signature to its recipient: without it a peer
// could forward a fresh signed request to a third server unchanged.
func signedPayload(senderDomain, audience, method, requestURI string, body []byte, timestamp int64, nonce string) string {
	var buf strings.Builder
	buf.Grow(len(senderDomain) + len(audience) + len(method) + len(requestURI) + len(body) + len(nonce) + 32)
	buf.WriteString(senderDomain)
	buf.WriteByte('|')
	buf.WriteString(audience)
	buf.WriteByte('|')
	buf.WriteString(method)
	buf.WriteByte('|')
	buf.WriteString(requestURI)
	buf.WriteByte('|')
	buf.Write(body)
	buf.WriteByte('|')
	buf.WriteString(strconv.FormatInt(timestamp, 10))
	buf.WriteByte('|')
	buf.WriteString(nonce)

	return buf.String()
}

// WellKnownHandler handles GET /.well-known/fast-chat requests.
func (m *Manager) WellKnownHandler(w http.ResponseWriter, _ *http.Request) {
	pemStr, err := m.publicKeyPEM()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"serverDomain":     m.serverDomain,
		"publicKeyPem":     pemStr,
		"protocolVersions": []int{CurrentProtocolVersion},
	})
}

// PublicKeyPEM returns the public key in PEM format.
func (m *Manager) PublicKeyPEM() (string, error) {
	return m.publicKeyPEM()
}

// ProtocolVersion returns the highest protocol version common to this server
// and the peer. Peers whose well-known predates the protocolVersions field are
// treated as incompatible; the request then fails instead of shipping a
// payload the peer cannot decrypt.
func (m *Manager) ProtocolVersion(ctx context.Context, serverDomain string) (int, error) {
	if serverDomain == m.serverDomain {
		return CurrentProtocolVersion, nil
	}

	// The well-known document is fetched by Verify on the inbound side.
	// Assume the current version for an unseen peer: since E2EE v3 a v1 peer
	// cannot read our payloads, and letting it reject the request with a
	// clear status beats silently sending undecryptable ciphertext.
	m.mu.RLock()
	entry := m.pubKeyCache[serverDomain]
	m.mu.RUnlock()
	if entry != nil && !entry.expiresAt.After(time.Now()) {
		// A peer may have upgraded since the cached well-known. Refresh it;
		// on failure keep the last known versions.
		if key, versions, err := m.fetchWellKnown(ctx, serverDomain); err == nil {
			entry = &cacheEntry{
				key:       key,
				versions:  versions,
				expiresAt: time.Now().Add(cacheTTL),
			}
			m.mu.Lock()
			m.pubKeyCache[serverDomain] = entry
			m.mu.Unlock()
		}
	}
	// A known peer with an empty version list has a pre-versioning
	// well-known (v1): it cannot read our payloads. Only an unseen peer is
	// assumed to speak the current version.
	versions := []int{CurrentProtocolVersion}
	if entry != nil {
		versions = entry.versions
	}

	best := 0
	for _, remote := range versions {
		if remote <= CurrentProtocolVersion && remote > best {
			best = remote
		}
	}
	if best != CurrentProtocolVersion {
		return 0, fmt.Errorf("%w: %q", ErrNoCommonProtocol, serverDomain)
	}
	return best, nil
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

	if !isValidFederationDomain(serverDomain) {
		return nil
	}

	m.mu.RLock()
	entry, ok := m.pubKeyCache[serverDomain]
	negExpiry, negOk := m.negCache[serverDomain]
	m.mu.RUnlock()

	if ok && time.Now().Before(entry.expiresAt) {
		return entry.key
	}

	// A recent failure short-circuits the fetch: without it every Verify
	// naming an unknown domain pays a DNS+HTTP round-trip before the
	// signature is even looked at.
	if negOk && time.Now().Before(negExpiry) {
		return nil
	}

	key, versions, err := m.fetchWellKnown(ctx, serverDomain)
	if err != nil {
		slog.Warn("failed to fetch .well-known", "server", serverDomain, "err", err)

		m.mu.Lock()
		m.negCache[serverDomain] = time.Now().Add(negCacheTTL)
		m.mu.Unlock()

		return nil
	}

	m.mu.Lock()
	// TOFU pinning: the first key seen for a domain is the only one this
	// process will trust. A later well-known that answers with a different
	// key means a compromised DNS, a hijacked host, or a rotation nobody
	// verified; refusing it fails closed instead of accepting the new
	// identity and verifying an attacker's signatures for that domain.
	if pinned, ok := m.pinnedKeys[serverDomain]; ok {
		if !pinned.Equal(key) {
			slog.Error("federation peer key changed, refusing the new key (DNS or identity takeover?)",
				"server", serverDomain)

			m.pubKeyCache[serverDomain] = &cacheEntry{
				key:       pinned,
				versions:  versions,
				expiresAt: time.Now().Add(m.cacheDuration),
			}
			m.mu.Unlock()

			return pinned
		}
	} else {
		m.pinnedKeys[serverDomain] = key
	}

	m.pubKeyCache[serverDomain] = &cacheEntry{
		key:       key,
		versions:  versions,
		expiresAt: time.Now().Add(m.cacheDuration),
	}
	delete(m.negCache, serverDomain)
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
	// Reserve the slot before the check-then-act: a burst of concurrent
	// verifies must not overshoot the cap together.
	swept := false

	for {
		count := m.nonceCount.Load()
		if count >= maxNonces {
			// The map is full. Expire what is already past the replay window
			// instead of denying Verify to everyone for the whole cleanup
			// tick: a flood of fresh nonces is exactly the state where the
			// ticker is too slow.
			if swept || !m.cleanupExpiredNonces(time.Now()) {
				return false
			}
			swept = true

			continue
		}
		if m.nonceCount.CompareAndSwap(count, count+1) {
			break
		}
	}

	key := serverDomain + ":" + signature
	entry := nonceEntry{expiresAt: time.Now().Add(replayWindow)}

	// Per-peer share first: a hostile peer must not eat the global cap.
	m.mu.Lock()
	if m.noncePerServer[serverDomain] >= maxNoncesPerServer {
		m.mu.Unlock()
		m.nonceCount.Add(-1)
		return false
	}
	m.noncePerServer[serverDomain]++
	m.mu.Unlock()

	if _, loaded := m.nonces.LoadOrStore(key, entry); loaded {
		// We've seen this exact (server, signature) pair before. Even if
		// the prior entry is technically past its expiry (clock skew,
		// slow cleanup tick), a duplicate signature is never legitimate
		// during the freshness window.
		m.nonceCount.Add(-1)
		m.mu.Lock()
		m.noncePerServer[serverDomain]--
		if m.noncePerServer[serverDomain] <= 0 {
			delete(m.noncePerServer, serverDomain)
		}
		m.mu.Unlock()
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
			m.cleanupExpiredNonces(time.Now())
		case <-m.closeCh:
			return
		}
	}
}

// cleanupExpiredNonces drops every replay entry past its window and reports
// whether it freed anything. It is shared by the ticker and by the inline
// sweep markNonceFresh runs when the map hits its cap.
func (m *Manager) cleanupExpiredNonces(now time.Time) bool {
	freed := false

	m.nonces.Range(func(key any, v any) bool {
		entry := v.(nonceEntry) //nolint:errcheck // invariant: only nonceEntry is stored
		if now.After(entry.expiresAt) {
			m.nonces.Delete(key)
			m.nonceCount.Add(-1)
			// The signature carries no colon, so everything
			// before the last one is the server domain.
			if keyStr, ok := key.(string); ok {
				if idx := strings.LastIndex(keyStr, ":"); idx > 0 {
					server := keyStr[:idx]
					m.mu.Lock()
					m.noncePerServer[server]--
					if m.noncePerServer[server] <= 0 {
						delete(m.noncePerServer, server)
					}
					m.mu.Unlock()
				}
			}

			freed = true
		}

		return true
	})

	return freed
}

// httpClient returns the client used for .well-known fetches. SetHTTPClient
// may replace it in tests, so every read takes the lock instead of touching
// the field directly.
func (m *Manager) httpClient() *http.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.client
}

// redirectSafeClient enforces the redirect policy even when a test injected
// its own client: a well-known response redirected to another host would
// otherwise cache a foreign key under the peer's domain.
func (m *Manager) redirectSafeClient() *http.Client {
	client := m.httpClient()
	if client == nil {
		return fallbackHTTPClient()
	}

	if client.CheckRedirect != nil {
		return client
	}

	clone := *client
	clone.CheckRedirect = noCrossHostRedirect

	return &clone
}

func (m *Manager) fetchWellKnown(ctx context.Context, serverDomain string) (*rsa.PublicKey, []int, error) {
	if !isValidFederationDomain(serverDomain) {
		return nil, nil, fmt.Errorf("%w %q", ErrInvalidFederationDomain, serverDomain)
	}

	wellKnownURL := fmt.Sprintf("%s://%s%s", m.scheme, serverDomain, wellKnownPath)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, wellKnownURL, http.NoBody)
	if err != nil {
		return nil, nil, fmt.Errorf("well-known request creation failed: %w", err)
	}

	// By design: peers are addressed by domain from X-Federation-Server.
	// NewSafeHTTPClient blocks private/loopback IPs at dial time and pins the
	// resolved IP (DNS-rebinding safe); a forged peer still fails signature
	// verification.
	// codeql[go/request-forgery]
	resp, err := m.redirectSafeClient().Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("well-known request failed: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // body close errors are not actionable

	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("%w: %d", ErrWellKnownStatus, resp.StatusCode)
	}

	var data struct {
		PublicKeyPem     string `json:"publicKeyPem"`
		ProtocolVersions []int  `json:"protocolVersions"`
		ServerDomain     string `json:"serverDomain"`
	}

	// The body is read before the request is authenticated: Verify fetches the
	// peer's key to check the signature, so an anonymous caller naming an
	// arbitrary host in X-Federation-Server reaches this decode with no
	// credential presented and a signature that need not be valid. Cap it so a
	// hostile peer cannot make the server allocate whatever it likes: the
	// payload is a single PEM public key of a few hundred bytes.
	resp.Body = http.MaxBytesReader(nil, resp.Body, maxWellKnownBody)

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, nil, fmt.Errorf("failed to decode well-known response: %w", err)
	}

	// The field is not part of the trust decision (the key is), but a peer
	// that declares a different name is worth a warning: it is either a
	// misconfigured mirror or a sign of a hijacked host.
	if data.ServerDomain != "" && data.ServerDomain != serverDomain {
		slog.Warn("well-known serverDomain does not match the requested host",
			"requested", serverDomain, "declared", data.ServerDomain)
	}

	key, err := parsePublicKeyPEM(data.PublicKeyPem)
	if err != nil {
		return nil, nil, err
	}
	return key, data.ProtocolVersions, nil
}

// isValidFederationDomain reports whether serverDomain is a bare host with
// an optional numeric port — and nothing else. The value is interpolated
// into the .well-known URL, so userinfo (@), paths (/), queries (?),
// fragments (#), spaces and control characters must never reach the URL
// builder: only a space is caught by http.NewRequest, the rest would
// silently reshape the request (e.g. "peer/@evil" or "a:127.0.0.1:9000").
//
// IP-range safety (loopback/private/link-local/multicast) is enforced by
// NewSafeHTTPClient at dial time, not here: tests inject a loopback-capable
// client via SetHTTPClient, and rejecting those ranges here would break
// them. Production traffic keeps both checks.
func isValidFederationDomain(domain string) bool {
	if !hasValidFederationCharset(domain) {
		return false
	}

	host, ok := splitFederationAuthority(domain)
	if !ok {
		return false
	}

	return isValidFederationHost(host)
}

// hasValidFederationCharset rejects empty, overlong and non-printable-ASCII
// domains plus the characters that would reshape the .well-known URL
// (userinfo @, path /, query ?, fragment #, whitespace).
func hasValidFederationCharset(domain string) bool {
	if domain == "" || len(domain) > 259 {
		return false
	}

	if strings.ContainsAny(domain, " \t\r\n/@?#") {
		return false
	}

	for _, r := range domain {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}

	return true
}

// splitFederationAuthority splits an optional numeric port off the domain.
// A second colon outside host:port form is only valid as a plain IP literal;
// anything else (e.g. "x:127.0.0.1:9000") is a crafted authority.
func splitFederationAuthority(domain string) (string, bool) {
	if host, port, err := net.SplitHostPort(domain); err == nil {
		if host == "" || port == "" {
			return "", false
		}

		if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
			return "", false
		}

		return host, true
	}

	if strings.Count(domain, ":") > 1 {
		if ip := net.ParseIP(domain); ip == nil {
			return "", false
		}

		return domain, true
	}

	return domain, true
}

// isValidFederationHost validates the host part: an IP literal is
// syntactically valid (the dialer decides whether it is safe to connect
// to), otherwise a bare DNS name of letter/digit/hyphen labels.
func isValidFederationHost(host string) bool {
	host = strings.Trim(host, "[]")
	if host == "" || len(host) > 253 {
		return false
	}

	if ip := net.ParseIP(host); ip != nil {
		return true
	}

	if host == "localhost" || host == "localhost." {
		return true
	}

	for label := range strings.SplitSeq(host, ".") {
		if !isValidFederationLabel(label) {
			return false
		}
	}

	return true
}

// isValidFederationLabel checks one DNS label: 1-63 chars of letters,
// digits and hyphens, not starting or ending with a hyphen.
func isValidFederationLabel(label string) bool {
	if label == "" || len(label) > 63 {
		return false
	}

	for i := range len(label) {
		c := label[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' {
			continue
		}

		return false
	}

	return label[0] != '-' && label[len(label)-1] != '-'
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
