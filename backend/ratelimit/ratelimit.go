// Package ratelimit provides a simple in-memory rate limiter.
package ratelimit

import (
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

func ClientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if idx := strings.Index(fwd, ","); idx != -1 {
			return strings.TrimSpace(fwd[:idx])
		}

		return strings.TrimSpace(fwd)
	}

	if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		return realIP
	}

	return r.RemoteAddr
}
