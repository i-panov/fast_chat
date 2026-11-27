package sse

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// A bind rejected by the per-user cap must leave the connection
// unauthenticated: the old code stored the binding first and only then found
// the cap, so a retried sse-auth replayed successfully and the stream never
// received an event.
func TestBindSessionRejectedAtCapLeavesTheConnectionUnauthenticated(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	exp := time.Now().Add(time.Hour)
	for i := range maxConnectionsPerUser {
		id := fmt.Sprintf("c%d", i)
		h.Register(id)
		if _, err := h.BindSession(id, "u1", fmt.Sprintf("s%d", i), exp); err != nil {
			t.Fatalf("bind %s: %v", id, err)
		}
	}

	h.Register("extra")
	if _, err := h.BindSession("extra", "u1", "s-extra", exp); !errors.Is(err, ErrTooManyConnections) {
		t.Fatalf("bind over cap: err = %v, want ErrTooManyConnections", err)
	}

	conn := h.GetConnection("extra")
	conn.Lock()
	authorized := conn.Authorized
	userID := conn.UserID
	conn.Unlock()

	if authorized || userID != "" {
		t.Fatalf("rejected bind mutated the connection: authorized=%v userID=%q", authorized, userID)
	}

	// The retry must fail the same way instead of answering 200.
	if _, err := h.BindSession("extra", "u1", "s-extra", exp); !errors.Is(err, ErrTooManyConnections) {
		t.Fatalf("replay of a rejected bind: err = %v, want ErrTooManyConnections", err)
	}
}

// A replay of sse-auth after the connection lost its index entry (a reap or an
// eviction) must repair the index, not answer 200 for a stream that will never
// receive an event.
func TestBindSessionReplayRepairsAMissingIndex(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	h.Register("c1")
	exp := time.Now().Add(time.Hour)
	if _, err := h.BindSession("c1", "u1", "s1", exp); err != nil {
		t.Fatal(err)
	}

	// Simulate the stale state a reap used to leave behind.
	h.mu.Lock()
	h.userConns = make(map[string][]string)
	h.sessionConns = make(map[string]map[string]struct{})
	h.mu.Unlock()

	if _, err := h.BindSession("c1", "u1", "s1", exp); err != nil {
		t.Fatalf("replay: %v", err)
	}

	h.mu.RLock()
	userCount := len(h.userConns["u1"])
	sessionCount := len(h.sessionConns["s1"])
	h.mu.RUnlock()

	if userCount != 1 || sessionCount != 1 {
		t.Fatalf("the replay did not restore the indexes: user=%d session=%d", userCount, sessionCount)
	}
}

// Reaping a stale connection must drop its index entry too: the leaked ids
// were counted against the per-user cap forever and locked realtime out until
// a restart.
func TestReapDropsTheIndexEntriesOfTheVictim(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	conn := h.Register("stale")
	conn.Lock()
	conn.UserID = "u1"
	conn.SessionID = "s1"
	conn.ExpiresAt = time.Now().Add(-time.Minute)
	conn.Authorized = false
	conn.CreatedAt = time.Now().Add(-2 * hubAuthTimeout)
	conn.Unlock()

	h.mu.Lock()
	h.userConns["u1"] = []string{"stale"}
	h.sessionConns["s1"] = map[string]struct{}{"stale": {}}
	h.mu.Unlock()

	h.Register("fresh")

	if h.GetConnection("stale") != nil {
		t.Fatal("the stale connection must be reaped")
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	if len(h.userConns["u1"]) != 0 {
		t.Fatalf("stale user index entries left: %v", h.userConns["u1"])
	}
	if len(h.sessionConns["s1"]) != 0 {
		t.Fatalf("stale session index entries left: %v", h.sessionConns["s1"])
	}
}

// A refresh proves the session is alive again: the stream Send marked as
// expired must not stay a ping-only zombie.
func TestUpdateSessionExpiryRestoresAuthorization(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	h.Register("c1")
	exp := time.Now().Add(time.Hour)
	if _, err := h.BindSession("c1", "u1", "s1", exp); err != nil {
		t.Fatal(err)
	}

	// What Send does when it sees an expired token.
	conn := h.GetConnection("c1")
	conn.Lock()
	conn.Authorized = false
	conn.Unlock()

	h.UpdateSessionExpiry("s1", exp.Add(time.Hour))

	conn.Lock()
	authorized := conn.Authorized
	conn.Unlock()

	if !authorized {
		t.Fatal("a refreshed session must restore its stream")
	}
}

// A stale session index entry must not close a stream that now belongs to
// another session of the same user.
func TestCloseSessionIgnoresAStaleIndexEntry(t *testing.T) {
	h := NewHub(time.Hour)
	defer h.Close()

	h.Register("c1")
	exp := time.Now().Add(time.Hour)
	if _, err := h.BindSession("c1", "u1", "s-new", exp); err != nil {
		t.Fatal(err)
	}

	h.mu.Lock()
	h.sessionConns["s-old"] = map[string]struct{}{"c1": {}}
	h.mu.Unlock()

	h.CloseSession("s-old")

	if h.GetConnection("c1") == nil {
		t.Fatal("a stale index entry closed a live stream")
	}
}
