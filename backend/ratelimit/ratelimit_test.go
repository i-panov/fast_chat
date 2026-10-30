package ratelimit

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestForwardedClientIP(t *testing.T) {
	// A single proxy that appends the peer it saw.
	direct := NewClientIPExtractor(nil)

	// Two hops: 10.0.0.0/8 is the proxy network, so both proxy entries are
	// trusted and only the client entry survives.
	chained := NewClientIPExtractor([]string{"10.0.0.0/8"})

	t.Run("single X-Forwarded-For", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "203.0.113.7")

		got, ok := direct.forwardedClientIP(r)
		if !ok || got != "203.0.113.7" {
			t.Fatalf("got %q, %v; want 203.0.113.7, true", got, ok)
		}
	})

	t.Run("chain yields the rightmost untrusted hop", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		// nginx appends the peer it saw; 10.0.0.1 is the trusted inner proxy.
		r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")

		got, ok := chained.forwardedClientIP(r)
		if !ok || got != "203.0.113.7" {
			t.Fatalf("got %q, %v; want the client 203.0.113.7, not a proxy", got, ok)
		}
	})

	t.Run("spoofed prefix is ignored", func(t *testing.T) {
		// Whatever the client prepends must not be able to become the key.
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8, 10.0.0.1")

		got, ok := chained.forwardedClientIP(r)
		if !ok || got != "5.6.7.8" {
			t.Fatalf("got %q, %v; want the rightmost untrusted hop 5.6.7.8", got, ok)
		}
	})

	t.Run("garbage in the client-supplied prefix is ignored", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "garbage, 203.0.113.7, 10.0.0.1")

		got, ok := chained.forwardedClientIP(r)
		if !ok || got != "203.0.113.7" {
			t.Fatalf("got %q, %v; want 203.0.113.7", got, ok)
		}
	})

	t.Run("chain of only trusted proxies yields nothing", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "10.0.0.1, 10.0.0.2")

		if got, ok := chained.forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})

	t.Run("malformed trailing entry yields no forwarded IP", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "203.0.113.7, not-an-ip")

		// The chain is walked from the right, so a malformed entry is only
		// reached before a usable one; here it is, and the chain is untrusted.
		if got, ok := chained.forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})

	t.Run("malformed XFF falls back to X-Real-IP", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "not-an-ip")
		r.Header.Set("X-Real-IP", "198.51.100.42")

		got, ok := chained.forwardedClientIP(r)
		if !ok || got != "198.51.100.42" {
			t.Fatalf("got %q, %v; want 198.51.100.42, true", got, ok)
		}
	})

	t.Run("IPv6 in XFF", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "2001:db8::1")

		got, ok := direct.forwardedClientIP(r)
		if !ok || got != "2001:db8::1" {
			t.Fatalf("got %q, %v; want 2001:db8::1, true", got, ok)
		}
	})

	t.Run("no proxy headers", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)

		if got, ok := direct.forwardedClientIP(r); ok {
			t.Fatalf("got %q, true; want zero value", got)
		}
	})

	t.Run("blank headers", func(t *testing.T) {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.Header.Set("X-Forwarded-For", "   ")
		r.Header.Set("X-Real-IP", "   ")

		if got, ok := direct.forwardedClientIP(r); ok {
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

// TestRotatingForwardedForCannotBypassTheLimiter is the regression for taking
// the leftmost X-Forwarded-For entry. A proxy appends the peer it saw, so
// everything in front of that is client-supplied; reading it gave an attacker
// a fresh bucket per request and disabled the limit entirely.
func TestRotatingForwardedForCannotBypassTheLimiter(t *testing.T) {
	ext := NewClientIPExtractor([]string{"10.0.0.0/8"})

	const limit = 5

	limiter := New(limit, time.Minute, 1000)

	// A trusted proxy peer, 10.0.0.1, and a client that rotates the prefix it
	// prepends. The real client address (198.51.100.7) sits where the proxy put
	// it, at the end.
	//
	// Every request must land in the same bucket, so exactly `limit` of them
	// are allowed and the rest are rejected. Before the fix each request got
	// its own key and all twenty passed.
	for i := range 20 {
		r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
		r.RemoteAddr = "10.0.0.1:3128"
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d, 198.51.100.7", i))

		allowed := limiter.Allow(ext.ClientIP(r))

		switch {
		case i < limit && !allowed:
			t.Fatalf("request %d rejected inside the limit of %d", i, limit)
		case i >= limit && allowed:
			t.Fatalf("request %d allowed past the limit of %d; the rotating XFF prefix created a new bucket", i, limit)
		}
	}
}

// TestClientInsideTrustedRangeIsSkipped pins the documented limitation of the
// right-to-left walk: a real client connecting from an address inside a trusted
// range is indistinguishable from a proxy hop, so it is skipped and the address
// the client forged to its left becomes the key.
//
// This is why config.ServerConfig.TrustedProxies must list proxy hops only. It
// is a property of the approach (gin and Express trust-proxy behave the same),
// so the test fixes the behaviour rather than the behaviour being a bug.
func TestClientInsideTrustedRangeIsSkipped(t *testing.T) {
	ext := NewClientIPExtractor([]string{"10.0.0.0/8"})

	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/", http.NoBody)
	r.RemoteAddr = "10.0.0.1:3128"
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 10.0.0.55")

	got := ext.ClientIP(r)
	if got != "1.2.3.4" {
		t.Fatalf("got %q, want 1.2.3.4: a client inside a trusted range is skipped as a proxy", got)
	}
}

// TestMalformedTrustedProxyIsReported covers the silent downgrade: an entry
// that can never match leaves the extractor falling back to the direct peer
// while the operator believes client IPs are resolved per client.
func TestMalformedTrustedProxyIsReported(t *testing.T) {
	var buf bytes.Buffer

	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))

	defer slog.SetDefault(previous)

	NewClientIPExtractor([]string{"10.0.0.1", "not-an-ip", "10.0.0.0/33", "10.0.0.0/8"})

	out := buf.String()
	for _, want := range []string{"not-an-ip", "10.0.0.0/33"} {
		if !strings.Contains(out, want) {
			t.Errorf("malformed entry %q was not reported; got: %s", want, out)
		}
	}

	// The valid entries must not produce noise.
	if strings.Contains(out, "10.0.0.1 ") || strings.Contains(out, "10.0.0.0/8") {
		t.Errorf("valid entries were reported as malformed: %s", out)
	}
}

// TestMaxEntriesIsAnActualCap covers the bound that gave the field its name.
// Reaching it only triggered a sweep of expired keys, so a flood of distinct
// keys — spoofed forwarded addresses, or a client with a large IPv6 prefix —
// grew the map without limit, and every request past the threshold walked all of
// it while holding the mutex.
func TestMaxEntriesIsAnActualCap(t *testing.T) {
	const maxEntries = 50

	rl := New(5, time.Minute, maxEntries)
	defer rl.Close()

	for i := range maxEntries * 4 {
		if !rl.Allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256)) {
			t.Fatalf("request %d from a fresh key was denied", i)
		}
	}

	rl.mu.Lock()
	got := len(rl.entries)
	rl.mu.Unlock()

	if got > maxEntries {
		t.Errorf("entries = %d, want at most %d", got, maxEntries)
	}
}

// TestSaturatedLimiterStillThrottlesAnActiveKey is the property that makes the
// bound safe. Bounding memory means something has to be forgotten, so the
// question is what: if a flood of one-off keys could push a live client out of
// the map, that client would start over with a full budget every time and the
// limiter would be bypassable by sending padding traffic. A key that keeps
// sending refreshes its own timestamp and so stays the newest.
func TestSaturatedLimiterStillThrottlesAnActiveKey(t *testing.T) {
	rl := New(3, time.Minute, 4)
	defer rl.Close()

	// Saturate with one-off keys.
	for i := range 16 {
		if !rl.Allow(fmt.Sprintf("filler-%d", i)) {
			t.Fatalf("padding request %d denied", i)
		}
	}

	allowed := 0

	for range 10 {
		if rl.Allow("target") {
			allowed++
		}
	}

	if allowed != 3 {
		t.Errorf("target was allowed %d of 10 under a saturated map, want 3: "+
			"a client that keeps sending must not lose its history to eviction", allowed)
	}
}

// TestAllowStillCountsAfterEviction makes sure bounding memory did not turn the
// limiter into a pass-through: an evicted key that keeps sending is counted
// again from its new entry.
func TestAllowStillCountsAfterEviction(t *testing.T) {
	rl := New(3, time.Minute, 2)
	defer rl.Close()

	for i := range 8 {
		rl.Allow(fmt.Sprintf("filler-%d", i))
	}

	allowed := 0

	for range 10 {
		if rl.Allow("target") {
			allowed++
		}
	}

	if allowed > 3 {
		t.Errorf("target was allowed %d times, want at most the limit of 3", allowed)
	}
}

// TestCloseIsIdempotent covers a shutdown path that can reach Close twice: the
// second call would panic on an already closed channel, and a panic while
// tearing down hides whatever else failed.
func TestCloseIsIdempotent(_ *testing.T) {
	rl := New(5, time.Minute, 10)

	rl.Close()
	rl.Close()
}

// TestNewWithoutABoundDoesNotGrowForever documents the zero case: an unset
// maxEntries must not mean "evict on every request", which would turn each
// request into a full map walk.
func TestNewWithoutABoundDoesNotGrowForever(t *testing.T) {
	rl := New(5, time.Minute, 0)
	defer rl.Close()

	for i := range 200 {
		rl.Allow(fmt.Sprintf("10.1.%d.%d", i/256, i%256))
	}

	rl.mu.Lock()
	got := len(rl.entries)
	rl.mu.Unlock()

	if got == 0 {
		t.Error("every entry was evicted; a zero bound must not disable counting")
	}

	if got > 200 {
		t.Errorf("entries = %d, want at most the 200 keys inserted", got)
	}
}

// TestPruneTimestampsKeepsLiveSuffix is the regression for the inverted
// prune: with a window of [expired, live] the old code returned
// timestamps[:0] (empty) on the first expired entry, resetting the window
// and letting one extra request through. The live suffix must survive.
func TestPruneTimestampsKeepsLiveSuffix(t *testing.T) {
	now := time.Now()
	cutoff := now.Add(-time.Minute)

	expired := now.Add(-2 * time.Minute)
	live := now

	got := pruneTimestamps([]time.Time{expired, live}, cutoff)
	if len(got) != 1 || !got[0].Equal(live) {
		t.Fatalf("pruneTimestamps([expired,live]) = %v, want [live]", got)
	}

	if got := pruneTimestamps([]time.Time{expired}, cutoff); len(got) != 0 {
		t.Fatalf("pruneTimestamps([expired]) = %v, want empty", got)
	}

	if got := pruneTimestamps([]time.Time{live}, cutoff); len(got) != 1 {
		t.Fatalf("pruneTimestamps([live]) = %v, want [live]", got)
	}

	if got := pruneTimestamps(nil, cutoff); len(got) != 0 {
		t.Fatalf("pruneTimestamps(nil) = %v, want empty", got)
	}
}
