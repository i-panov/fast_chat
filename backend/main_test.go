package main

import (
	"testing"
	"time"
)

func TestRateLimiterAllowsUnderLimit(t *testing.T) {
	rl := newRateLimiter(3, time.Minute)
	defer close(rl.closeCh)

	for i := 0; i < 3; i++ {
		if !rl.allow("1.1.1.1") {
			t.Errorf("call %d: expected allow", i+1)
		}
	}
}

func TestRateLimiterBlocksOverLimit(t *testing.T) {
	rl := newRateLimiter(3, time.Minute)
	defer close(rl.closeCh)

	for i := 0; i < 3; i++ {
		rl.allow("1.1.1.1")
	}

	if rl.allow("1.1.1.1") {
		t.Error("4th call must be blocked")
	}
}

func TestRateLimiterIsolatesByIP(t *testing.T) {
	rl := newRateLimiter(2, time.Minute)
	defer close(rl.closeCh)

	rl.allow("1.1.1.1")
	rl.allow("1.1.1.1")
	if rl.allow("1.1.1.1") {
		t.Error("1.1.1.1 should be blocked")
	}

	if !rl.allow("2.2.2.2") {
		t.Error("2.2.2.2 must be allowed (different IP)")
	}
}

func TestRateLimiterWindowExpires(t *testing.T) {
	rl := newRateLimiter(2, 50*time.Millisecond)
	defer close(rl.closeCh)

	rl.allow("1.1.1.1")
	rl.allow("1.1.1.1")
	if rl.allow("1.1.1.1") {
		t.Fatal("3rd call must be blocked within window")
	}

	time.Sleep(60 * time.Millisecond)

	if !rl.allow("1.1.1.1") {
		t.Error("after window expires the limit must reset")
	}
}

func TestRateLimiterCleanupDropsStale(t *testing.T) {
	rl := newRateLimiter(2, 30*time.Millisecond)
	defer close(rl.closeCh)

	rl.allow("1.1.1.1")
	rl.allow("2.2.2.2")

	time.Sleep(50 * time.Millisecond)

	// Wait for the cleanup ticker (one window = 30ms) plus a little slack.
	time.Sleep(50 * time.Millisecond)

	rl.mu.Lock()
	n := len(rl.entries)
	rl.mu.Unlock()

	if n != 0 {
		t.Errorf("expected empty entries after cleanup, got %d", n)
	}
}
