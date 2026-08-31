package ratelimit

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestForwardedClientIP(t *testing.T) {
	t.Run("single X-Forwarded-For", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "203.0.113.7")

		got, ok := forwardedClientIP(r)
		if !ok || got != "203.0.113.7" {
			t.Fatalf("got %q, %v; want 203.0.113.7, true", got, ok)
		}
	})

	t.Run("X-Forwarded-For chain picks first", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.9 ,10.0.0.1")

		got, ok := forwardedClientIP(r)
		if !ok || got != "203.0.113.7" {
			t.Fatalf("got %q, %v; want 203.0.113.7, true", got, ok)
		}
	})

	t.Run("invalid first XFF value yields no forwarded IP", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "garbage, 203.0.113.7")

		// Only the first XFF entry is considered; garbage there means the
		// proxy chain is untrustworthy and the IP is ignored entirely.
		if got, ok := forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})

	t.Run("invalid XFF falls back to X-Real-IP", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "not-an-ip")
		r.Header.Set("X-Real-IP", "198.51.100.42")

		got, ok := forwardedClientIP(r)
		if !ok || got != "198.51.100.42" {
			t.Fatalf("got %q, %v; want 198.51.100.42, true", got, ok)
		}
	})

	t.Run("IPv6 in XFF", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "2001:db8::1")

		got, ok := forwardedClientIP(r)
		if !ok || got != "2001:db8::1" {
			t.Fatalf("got %q, %v; want 2001:db8::1, true", got, ok)
		}
	})

	t.Run("no proxy headers", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)

		if got, ok := forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})

	t.Run("blank headers", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "   ")
		r.Header.Set("X-Real-IP", "   ")

		if got, ok := forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})
}

func TestNewClientIPExtractor(t *testing.T) {
	ext := NewClientIPExtractor([]string{"10.0.0.1", "192.168.1.0/24", "", "   "})

	if _, ok := ext.trustedIPs["10.0.0.1"]; !ok {
		t.Error("exact IP not registered")
	}

	if len(ext.trustedCIDRs) != 1 {
		t.Fatalf("expected 1 CIDR, got %d", len(ext.trustedCIDRs))
	}

	ip := net.ParseIP("192.168.1.99")
	if ip == nil || !ext.trustedCIDRs[0].Contains(ip) {
		t.Error("CIDR range should contain 192.168.1.99")
	}

	empty := NewClientIPExtractor(nil)
	if empty == nil || len(empty.trustedIPs) != 0 || len(empty.trustedCIDRs) != 0 {
		t.Error("empty extractor should have no trusted entries")
	}

	t.Run("invalid CIDR is skipped", func(t *testing.T) {
		ext := NewClientIPExtractor([]string{"999.1.1.1/33"})
		if len(ext.trustedIPs) != 0 || len(ext.trustedCIDRs) != 0 {
			t.Error("malformed CIDR should be skipped")
		}
	})
}

func TestClientIPExtractorClientIP(t *testing.T) {
	t.Run("untrusted peer: proxy headers ignored", func(t *testing.T) {
		ext := NewClientIPExtractor(nil)
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "203.0.113.9:1234"
		r.Header.Set("X-Forwarded-For", "1.2.3.4")

		if got := ext.ClientIP(r); got != "203.0.113.9" {
			t.Fatalf("got %q, want 203.0.113.9 (no proxy trust)", got)
		}
	})

	t.Run("trusted proxy by exact IP", func(t *testing.T) {
		ext := NewClientIPExtractor([]string{"10.0.0.1"})
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "10.0.0.1:8080"
		r.Header.Set("X-Forwarded-For", "203.0.113.7")

		if got := ext.ClientIP(r); got != "203.0.113.7" {
			t.Fatalf("got %q, want 203.0.113.7", got)
		}
	})

	t.Run("trusted proxy by CIDR", func(t *testing.T) {
		ext := NewClientIPExtractor([]string{"172.16.0.0/12"})
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "172.16.5.1:80"
		r.Header.Set("X-Real-IP", "198.51.100.3")

		if got := ext.ClientIP(r); got != "198.51.100.3" {
			t.Fatalf("got %q, want 198.51.100.3", got)
		}
	})

	t.Run("trusted proxy but invalid XFF falls back to remote", func(t *testing.T) {
		ext := NewClientIPExtractor([]string{"10.0.0.1"})
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "10.0.0.1:8080"
		r.Header.Set("X-Forwarded-For", "evil,")

		if got := ext.ClientIP(r); got != "10.0.0.1" {
			t.Fatalf("got %q, want 10.0.0.1 (fallback)", got)
		}
	})

	t.Run("nil extractor", func(t *testing.T) {
		var ext *ClientIPExtractor
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "203.0.113.9:1234"
		r.Header.Set("X-Forwarded-For", "6.6.6.6")

		if got := ext.ClientIP(r); got != "203.0.113.9" {
			t.Fatalf("got %q, want 203.0.113.9", got)
		}
	})
}

func TestRemoteHost(t *testing.T) {
	cases := map[string]string{
		"203.0.113.9:1234":  "203.0.113.9",
		"[2001:db8::1]:443": "2001:db8::1",
		"garbage":           "garbage",
		"":                  "",
		"203.0.113.9":       "203.0.113.9",
	}

	for in, want := range cases {
		if got := remoteHost(in); got != want {
			t.Errorf("remoteHost(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRateLimiterAllow(t *testing.T) {
	t.Run("allows up to limit then blocks", func(t *testing.T) {
		rl := New(3, time.Minute, 100)
		defer rl.Close()

		for i := range 3 {
			if !rl.Allow("1.2.3.4") {
				t.Fatalf("request %d should be allowed", i)
			}
		}

		if rl.Allow("1.2.3.4") {
			t.Fatal("request over the limit should be blocked")
		}
	})

	t.Run("different IPs have independent budgets", func(t *testing.T) {
		rl := New(1, time.Minute, 100)
		defer rl.Close()

		if !rl.Allow("a") {
			t.Fatal("a: first request blocked")
		}
		if rl.Allow("a") {
			t.Fatal("a: second request should be blocked")
		}
		if !rl.Allow("b") {
			t.Fatal("b: first request should be allowed")
		}
	})

	t.Run("window expiry allows again", func(t *testing.T) {
		rl := New(1, 30*time.Millisecond, 100)
		defer rl.Close()

		if !rl.Allow("x") {
			t.Fatal("first request blocked")
		}
		if rl.Allow("x") {
			t.Fatal("second request should be blocked inside the window")
		}

		time.Sleep(60 * time.Millisecond)

		if !rl.Allow("x") {
			t.Fatal("request after the window should be allowed")
		}
	})

	t.Run("max entries eviction frees stale slots", func(t *testing.T) {
		rl := New(1, 30*time.Millisecond, 1)
		defer rl.Close()

		if !rl.Allow("one") {
			t.Fatal("one: first request blocked")
		}

		time.Sleep(60 * time.Millisecond)

		if !rl.Allow("two") {
			t.Fatal("two: stale entry should be evicted to make room")
		}
	})
}
