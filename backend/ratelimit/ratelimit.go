// Package ratelimit provides a simple in-memory rate limiter.
package ratelimit

import (
	"net"
	"net/http"
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
func NewClientIPExtractor(trustedProxies []string) *ClientIPExtractor {
	e := &ClientIPExtractor{
		trustedIPs: make(map[string]struct{}, len(trustedProxies)),
	}

	for _, p := range trustedProxies {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}

		if strings.Contains(p, "/") {
			if _, network, err := net.ParseCIDR(p); err == nil {
				e.trustedCIDRs = append(e.trustedCIDRs, network)
			}

			continue
		}

		e.trustedIPs[p] = struct{}{}
	}

	return e
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

// ClientIP returns the client IP, honouring X-Forwarded-For/X-Real-IP
// only when the direct peer is a trusted proxy. Forwarded values that
// are not valid IPs are ignored to avoid polluting the limiter map with
// garbage keys.
func (e *ClientIPExtractor) ClientIP(r *http.Request) string {
	remoteIP := remoteHost(r.RemoteAddr)

	if e.isTrusted(remoteIP) {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			first := fwd
			if idx := strings.Index(fwd, ","); idx != -1 {
				first = fwd[:idx]
			}

			first = strings.TrimSpace(first)
			if net.ParseIP(first) != nil {
				return first
			}
		}

		if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
			if net.ParseIP(realIP) != nil {
				return realIP
			}
		}
	}

	return remoteIP
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

	if len(rl.entries) >= rl.maxEntries {
		now := time.Now()

		cutoff := now.Add(-rl.window)
		for ip, timestamps := range rl.entries {
			var valid []time.Time

			for _, t := range timestamps {
				if t.After(cutoff) {
					valid = append(valid, t)
				}
			}

			if len(valid) == 0 {
				delete(rl.entries, ip)
			} else {
				rl.entries[ip] = valid
			}
		}
	}

	now := time.Now()
	cutoff := now.Add(-rl.window)

	timestamps := rl.entries[ip]

	var valid []time.Time

	for _, t := range timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= rl.limit {
		rl.entries[ip] = valid

		return false
	}

	rl.entries[ip] = append(valid, now)

	return true
}

func (rl *RateLimiter) Close() {
	close(rl.closeCh)
}

func (rl *RateLimiter) clean() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			now := time.Now()
			cutoff := now.Add(-rl.window)

			for ip, timestamps := range rl.entries {
				var valid []time.Time

				for _, t := range timestamps {
					if t.After(cutoff) {
						valid = append(valid, t)
					}
				}

				if len(valid) == 0 {
					delete(rl.entries, ip)
				} else {
					rl.entries[ip] = valid
				}
			}

			rl.mu.Unlock()

		case <-rl.closeCh:
			return
		}
	}
}
