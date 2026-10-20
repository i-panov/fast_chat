// Package ratelimit provides a simple in-memory rate limiter.
package ratelimit

import (
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

type RateLimiter struct {
	mu         sync.Mutex
	entries    map[string][]time.Time
	limit      int
	window     time.Duration
	maxEntries int
	closeCh    chan struct{}
	closeOnce  sync.Once
}

// ClientIPExtractor resolves the client IP for rate limiting. Proxy
// headers are only trusted when the immediate peer is a configured
// trusted proxy; otherwise a client could spoof X-Forwarded-For and
// bypass the limiter.
type ClientIPExtractor struct {
	trustedIPs   map[string]struct{}
	trustedCIDRs []*net.IPNet
}

// NewClientIPExtractor builds an extractor from a list of trusted proxy
// IPs/CIDRs. An empty list means "trust no proxy headers". CIDRs are
// parsed once here so the hot path does not re-parse them per request.
// NewClientIPExtractor compiles the trusted proxy list.
//
// An entry that is neither a valid IP nor a valid CIDR is reported and dropped.
// It is dropped because it can never match, and reported because a silent drop
// is a security downgrade: the operator believes client IPs are being resolved
// per client while the extractor quietly falls back to the direct peer.
//
// Note what cannot be checked here. A range that wrongly includes real client
// addresses is undetectable at construction time, and undetectable per request
// too: the forged "untrusted, trusted" chain an attacker sends is byte for byte
// the same shape as a legitimate single-proxy chain. The only defences are the
// documented configuration rule and the test that pins the behaviour.
//
// Returns an extractor that is always usable.
func NewClientIPExtractor(trustedProxies []string) *ClientIPExtractor {
	extractor := &ClientIPExtractor{
		trustedIPs: make(map[string]struct{}, len(trustedProxies)),
	}

	for _, proxy := range trustedProxies {
		proxy = strings.TrimSpace(proxy)
		if proxy == "" {
			continue
		}

		if strings.Contains(proxy, "/") {
			if _, network, err := net.ParseCIDR(proxy); err == nil {
				extractor.trustedCIDRs = append(extractor.trustedCIDRs, network)
			} else {
				slog.Warn("ignoring malformed trusted_proxies CIDR; client IP extraction will fall back to the direct peer",
					"entry", proxy, "err", err)
			}

			continue
		}

		if net.ParseIP(proxy) == nil {
			slog.Warn("ignoring malformed trusted_proxies entry; client IP extraction will fall back to the direct peer",
				"entry", proxy)

			continue
		}

		extractor.trustedIPs[proxy] = struct{}{}
	}

	return extractor
}

// ClientIP returns the client IP, honouring X-Forwarded-For/X-Real-IP
// only when the direct peer is a trusted proxy. Forwarded values that
// are not valid IPs are ignored to avoid polluting the limiter map with
// garbage keys.
func (e *ClientIPExtractor) ClientIP(r *http.Request) string {
	remoteIP := remoteHost(r.RemoteAddr)

	if !e.isTrusted(remoteIP) {
		return remoteIP
	}

	if forwarded, ok := e.forwardedClientIP(r); ok {
		return forwarded
	}

	return remoteIP
}

// IsTrustedProxy reports whether the request came from a configured proxy.
// The headers of a request are only believed when the direct peer is such a
// proxy: otherwise a client could forge them.
func (e *ClientIPExtractor) IsTrustedProxy(r *http.Request) bool {
	if e == nil {
		return false
	}

	return e.isTrusted(remoteHost(r.RemoteAddr))
}

// forwardedClientIP resolves the client address from the proxy headers.
//
// X-Forwarded-For is appended to, not replaced, by a proxy: nginx's
// $proxy_add_x_forwarded_for puts the peer it saw at the end and leaves
// everything the client sent in front. Taking the leftmost entry therefore
// takes a value the client chose, so an attacker rotating it gets a fresh rate
// limit bucket per request and no limit applies at all.
//
// So the chain is walked from the right, skipping trusted proxies, and the
// first untrusted address wins. What that yields is the last hop this server
// can attribute, which is the best any single-hop resolver can do — and it
// assumes trusted_proxies names proxy hops only. A real client inside a trusted
// range is indistinguishable from a proxy and gets skipped, leaving the address
// it forged as the key. This matches gin and Express trust-proxy handling;
// configuring client address space here is a misconfiguration, not a bug.
func (e *ClientIPExtractor) forwardedClientIP(r *http.Request) (string, bool) {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")

		for _, entry := range slices.Backward(parts) {
			candidate := strings.TrimSpace(entry)
			if net.ParseIP(candidate) == nil {
				// A malformed entry makes the rest of the chain unusable: we
				// cannot tell which side of it was forged. Stop walking and
				// fall through to X-Real-IP, which is safe only insofar as the
				// proxy overwrites it (see config.ServerConfig.TrustedProxies).
				break
			}

			if !e.isTrusted(candidate) {
				return candidate, true
			}
		}
	}

	// Consulted only when the chain yields nothing, and only when the direct
	// peer is trusted (checked by the caller). That still does not make it
	// trustworthy on its own: a proxy that forwards the client's own X-Real-IP
	// (`proxy_set_header X-Real-IP $http_x_real_ip`) hands the client the key
	// again. Overwriting it is a configuration requirement, not a code
	// invariant, which is why it is spelled out in the config documentation.
	if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
		if net.ParseIP(realIP) != nil {
			return realIP, true
		}
	}

	return "", false
}

func (e *ClientIPExtractor) isTrusted(ip string) bool {
	if e == nil {
		return false
	}

	if _, ok := e.trustedIPs[ip]; ok {
		return true
	}

	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}

	for _, network := range e.trustedCIDRs {
		if network.Contains(parsed) {
			return true
		}
	}

	return false
}

func remoteHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}

	return host
}

func New(limit int, window time.Duration, maxEntries int) *RateLimiter {
	rl := &RateLimiter{
		entries:    make(map[string][]time.Time),
		limit:      limit,
		window:     window,
		maxEntries: maxEntries,
		closeCh:    make(chan struct{}),
	}

	go rl.clean()

	return rl
}

func (rl *RateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	if rl.atCapacity() {
		// Nothing has expired, so the map cannot shrink on its own and the
		// request would otherwise be the one that pushes it past the bound.
		rl.prune(cutoff)

		if rl.atCapacity() {
			rl.evictOldest()
		}
	}

	timestamps := pruneTimestamps(rl.entries[ip], cutoff)

	if len(timestamps) >= rl.limit {
		rl.entries[ip] = timestamps

		return false
	}

	rl.entries[ip] = append(timestamps, now)

	return true
}

// atCapacity reports whether the next request has to make room. A maxEntries of
// zero or less means "no bound configured", which is a valid configuration and
// must not degrade into evicting on every request.

// prune drops every timestamp that has fallen out of the window, and every key
// left with none. This is what bounds the map in the steady state: keys stop
// being added once their window has passed.

// evictOldest makes room when every key is still inside its window, which is
// what a flood of one-off keys looks like. The key closest to expiring goes
// first, so a client that is still sending keeps its history and a key that has
// already served its window is the one forgotten.
//
// Failing closed instead — refusing new keys while the map is full — would let
// anyone with rotating addresses deny service to everyone else, so the bound
// costs accuracy rather than availability.

// pruneTimestamps returns the timestamps still inside the window.
//
// Timestamps are appended in order, so the live ones are the tail and the first
// entry at or before the cutoff marks where they start. Reslicing keeps this
// allocation-free on the request path, and it leaves the spare capacity after
// the new length for the next append.
func pruneTimestamps(timestamps []time.Time, cutoff time.Time) []time.Time {
	for i, t := range timestamps {
		if !t.After(cutoff) {
			return timestamps[:i]
		}
	}

	return timestamps
}

// Close stops the cleanup goroutine. It is safe to call more than once, so two
// shutdown paths reaching it cannot turn into a panic that hides the original
// failure.
func (rl *RateLimiter) Close() {
	rl.closeOnce.Do(func() {
		close(rl.closeCh)
	})
}

func (rl *RateLimiter) atCapacity() bool {
	return rl.maxEntries > 0 && len(rl.entries) >= rl.maxEntries
}

func (rl *RateLimiter) prune(cutoff time.Time) {
	for ip, timestamps := range rl.entries {
		valid := pruneTimestamps(timestamps, cutoff)
		if len(valid) == 0 {
			delete(rl.entries, ip)
		} else {
			rl.entries[ip] = valid
		}
	}
}

func (rl *RateLimiter) evictOldest() {
	victim := ""
	var oldest time.Time

	for ip, timestamps := range rl.entries {
		if len(timestamps) == 0 {
			victim = ip
			break
		}

		// The last timestamp is the most recent hit, so it is the closest this
		// key is to being out of its window.
		last := timestamps[len(timestamps)-1]
		if victim == "" || last.Before(oldest) {
			victim, oldest = ip, last
		}
	}

	if victim == "" {
		return
	}

	delete(rl.entries, victim)
}

func (rl *RateLimiter) clean() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			rl.prune(time.Now().Add(-rl.window))
			rl.mu.Unlock()

		case <-rl.closeCh:
			return
		}
	}
}
