package main

import (
	"sync"
	"testing"
	"time"

	"fast_chat/ratelimit"
)

func newTestRateLimiter(limit int, window time.Duration) *ratelimit.RateLimiter {
	rl := ratelimit.New(limit, window, 10000)

	// Stop the background cleanup loop in tests so its 1-second tick
	// does not race with assertions.
	rl.Close()

	return rl
}

func TestRateLimiterAllowsUnderLimit(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(3, time.Minute)

	for i := range 3 {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("call %d: allow returned false under the limit", i+1)
		}
	}
}

func TestRateLimiterBlocksOverLimit(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(3, time.Minute)

	for i := range 3 {
		if !rl.Allow("1.2.3.4") {
			t.Fatalf("call %d: should be allowed", i+1)
		}
	}

	if rl.Allow("1.2.3.4") {
		t.Fatal("fourth call must be rejected")
	}
}

func TestRateLimiterIsolatesClients(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(2, time.Minute)

	if !rl.Allow("a") || !rl.Allow("a") {
		t.Fatal("a: under-limit calls should be allowed")
	}

	if rl.Allow("a") {
		t.Fatal("a: third call must be rejected")
	}

	if !rl.Allow("b") {
		t.Fatal("b: should not be affected by a's rate limit")
	}
}

func TestRateLimiterResetsAfterWindow(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(2, 50*time.Millisecond)

	if !rl.Allow("1.2.3.4") || !rl.Allow("1.2.3.4") {
		t.Fatal("two calls under the limit should be allowed")
	}

	if rl.Allow("1.2.3.4") {
		t.Fatal("third call inside the window must be rejected")
	}

	time.Sleep(80 * time.Millisecond)

	if !rl.Allow("1.2.3.4") {
		t.Fatal("after the window the limit must reset")
	}
}

func TestRateLimiterConcurrent(t *testing.T) {
	t.Parallel()

	rl := newTestRateLimiter(100, time.Minute)

	var wg sync.WaitGroup

	allowed := make(chan bool, 200)

	for range 200 {
		wg.Add(1)

		go func() {
			defer wg.Done()

			allowed <- rl.Allow("shared")
		}()
	}

	wg.Wait()
	close(allowed)

	var count int
	for ok := range allowed {
		if ok {
			count++
		}
	}

	if count != 100 {
		t.Fatalf("expected exactly 100 allowed calls under concurrent load, got %d", count)
	}
}
