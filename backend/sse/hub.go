// Package sse provides a Server-Sent Events hub for real-time messaging.
package sse

import (
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"
)

const (
	HeartbeatInterval = 30 * time.Second
	channelBuffer     = 128
	// maxHubConnections bounds the hub map: every Register allocates a
	// 128-event channel, so anonymous callers naming fresh connectionIds
	// must not grow it without bound. Authenticated connections always get
	// a slot; under pressure the oldest unauthenticated one is evicted.
	maxHubConnections = 10000
	// maxConnectionsPerUser stops one account from exhausting the transport's
	// SSE backstop (1024 streams) and silencing realtime for everyone. The
	// oldest stream of the same user is evicted instead of rejecting the new
	// one: a crashed browser must not lock the account out until token expiry.
	maxConnectionsPerUser = 8
	// hubAuthTimeout is how long an unauthenticated connection may hold its
	// slot: Register happens before the auth request, and a client that
	// never authenticates must not keep the channel forever.
	hubAuthTimeout = 30 * time.Second
)

var (
	ErrConnectionNotFound = errors.New("connection not found")
	// ErrConnectionInUse reports an attempt to rebind an already authorized
	// connection to another user or session. Rebinding would leak the
	// presence bookkeeping of the first binding.
	ErrConnectionInUse = errors.New("connection already authorized to another session")
	// ErrTooManyConnections reports the per-user stream cap. Evicting a live
	// stream made every client reconnect and evict the next one.
	ErrTooManyConnections = errors.New("too many connections for this user")
)

type Event struct {
	Event string
	Data  any
}

type Connection struct {
	mu         sync.Mutex
	ID         string
	UserID     string
	SessionID  string
	ExpiresAt  time.Time
	Authorized bool
	Warned     bool
	Channel    chan Event
	// CreatedAt marks the Register time: an unauthenticated connection
	// older than hubAuthTimeout is stale and may be reclaimed.
	CreatedAt time.Time
}

func (c *Connection) Lock()   { c.mu.Lock() }
func (c *Connection) Unlock() { c.mu.Unlock() }

type Hub struct {
	mu           sync.RWMutex
	connections  map[string]*Connection
	userConns    map[string][]string
	sessionConns map[string]map[string]struct{}
	lastTyping   sync.Map
	closeCh      chan struct{}
}

func NewHub(cleanupInterval time.Duration) *Hub {
	hub := &Hub{
		connections:  make(map[string]*Connection),
		userConns:    make(map[string][]string),
		sessionConns: make(map[string]map[string]struct{}),
		closeCh:      make(chan struct{}),
	}
	go hub.cleanupLastTyping(cleanupInterval)

	return hub
}

func (h *Hub) Close() {
	select {
	case <-h.closeCh:
	default:
		close(h.closeCh)
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	for id, conn := range h.connections {
		close(conn.Channel)
		delete(h.connections, id)
	}
	h.userConns = make(map[string][]string)
	h.sessionConns = make(map[string]map[string]struct{})
}

func (h *Hub) LoadLastTyping(key string) (any, bool) {
	return h.lastTyping.Load(key)
}

func (h *Hub) StoreLastTyping(key string, value time.Time) {
	h.lastTyping.Store(key, value)
}

func (h *Hub) Register(connectionID string) *Connection {
	h.mu.Lock()
	defer h.mu.Unlock()

	if existing, ok := h.connections[connectionID]; ok {
		close(existing.Channel)

		if existing.UserID != "" {
			conns := h.userConns[existing.UserID]
			for i, c := range conns {
				if c == connectionID {
					h.userConns[existing.UserID] = append(conns[:i], conns[i+1:]...)
					break
				}
			}
		}
	}

	now := time.Now()
	h.reapStaleUnauthenticatedLocked(now)

	if len(h.connections) >= maxHubConnections {
		// No stale slots to reclaim. Evict the oldest unauthenticated
		// connection so an anonymous flood cannot deny slots to
		// authenticated users; if every slot is authenticated, log and
		// still register (never return nil: the transport dereferences
		// the result unconditionally).
		if victim := h.oldestUnauthenticatedLocked(); victim != "" {
			if conn, ok := h.connections[victim]; ok {
				close(conn.Channel)
				delete(h.connections, victim)
			}

			slog.Warn("SSE hub at capacity, evicted oldest unauthenticated connection",
				"evicted", victim, "new", connectionID)
		} else {
			slog.Warn("SSE hub over capacity with all connections authenticated",
				"connections", len(h.connections), "new", connectionID)
		}
	}

	conn := &Connection{
		ID:        connectionID,
		Channel:   make(chan Event, channelBuffer),
		CreatedAt: now,
	}
	h.connections[connectionID] = conn

	return conn
}

// ConnectionCount reports the number of registered connections.
func (h *Hub) ConnectionCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return len(h.connections)
}

// CloseExpiredUnauthenticated closes unauthenticated connections older than
// hubAuthTimeout and reports how many were reclaimed.
func (h *Hub) CloseExpiredUnauthenticated(now time.Time) int {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.reapStaleUnauthenticatedLocked(now)
}

func (h *Hub) Unregister(connectionID string, conn *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Only tear down if this connection is still the registered one.
	// A reconnect reuses the same connectionID: Register() replaces the
	// old entry, and the old handler's deferred Unregister must not
	// close the new connection's channel.
	current, ok := h.connections[connectionID]
	if !ok || current != conn {
		return
	}

	close(current.Channel)
	delete(h.connections, connectionID)

	if current.UserID != "" {
		conns := h.userConns[current.UserID]
		for i, c := range conns {
			if c == connectionID {
				h.userConns[current.UserID] = append(conns[:i], conns[i+1:]...)
				break
			}
		}

		if len(h.userConns[current.UserID]) == 0 {
			delete(h.userConns, current.UserID)
		}
	}

	if current.SessionID != "" {
		if conns := h.sessionConns[current.SessionID]; conns != nil {
			delete(conns, connectionID)
			if len(conns) == 0 {
				delete(h.sessionConns, current.SessionID)
			}
		}
	}
}

func (h *Hub) GetConnection(connectionID string) *Connection {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return h.connections[connectionID]
}

// BindSession atomically binds a connection to a session. It reports whether
// this call created a new binding: a replay for the same user and session only
// refreshes the expiry, so the caller must not count presence again.
//
// A connection already authorized to another user or session is rejected with
// ErrConnectionInUse instead of being rebound.
func (h *Hub) BindSession(connectionID, userID, sessionID string, expiresAt time.Time) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.connections[connectionID]
	if !ok {
		return false, ErrConnectionNotFound
	}

	conn.mu.Lock()

	// Compare the binding, not Authorized: an expiry race may have flipped
	// Authorized off for the very same binding, and that is still a replay.
	switch {
	case conn.UserID == userID && conn.SessionID == sessionID:
		conn.ExpiresAt = expiresAt
		conn.Authorized = true
		conn.Warned = false
		conn.mu.Unlock()

		return false, nil
	case conn.Authorized:
		conn.mu.Unlock()

		return false, ErrConnectionInUse
	}

	conn.UserID = userID
	conn.SessionID = sessionID
	conn.ExpiresAt = expiresAt
	conn.Authorized = true
	conn.Warned = false
	conn.mu.Unlock()

	// Avoid duplicate entries if sseAuth is replayed for the same
	// connection (e.g. a retried auth request).
	if !slices.Contains(h.userConns[userID], connectionID) {
		if len(h.userConns[userID]) >= maxConnectionsPerUser {
			return false, ErrTooManyConnections
		}
		h.userConns[userID] = append(h.userConns[userID], connectionID)
	}
	if sessionID != "" {
		if h.sessionConns[sessionID] == nil {
			h.sessionConns[sessionID] = make(map[string]struct{})
		}
		h.sessionConns[sessionID][connectionID] = struct{}{}
	}

	return true, nil
}

// AuthenticateSession binds a connection to a user session. It keeps the
// pre-BindSession API; callers that must count presence use BindSession to
// learn whether the binding is new.
func (h *Hub) AuthenticateSession(connectionID, userID, sessionID string, expiresAt time.Time) error {
	_, err := h.BindSession(connectionID, userID, sessionID, expiresAt)

	return err
}

// CloseSession closes every SSE stream of one session, leaving the other
// sessions of the user untouched.
func (h *Hub) CloseSession(sessionID string) {
	if sessionID == "" {
		return
	}

	for _, id := range h.sessionConnectionIDs(sessionID) {
		if conn := h.GetConnection(id); conn != nil {
			h.Unregister(id, conn)
		}
	}
}

// CloseUserSessions closes every SSE stream of the user.
func (h *Hub) CloseUserSessions(userID string) {
	h.mu.RLock()
	ids := append([]string(nil), h.userConns[userID]...)
	h.mu.RUnlock()

	for _, id := range ids {
		if conn := h.GetConnection(id); conn != nil {
			h.Unregister(id, conn)
		}
	}
}

// UpdateSessionExpiry propagates a refreshed session expiry to its live
// streams, so the heartbeat does not warn or expire them early.
func (h *Hub) UpdateSessionExpiry(sessionID string, expiresAt time.Time) {
	if sessionID == "" {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for id := range h.sessionConns[sessionID] {
		conn := h.connections[id]
		if conn == nil {
			continue
		}
		conn.mu.Lock()
		if conn.SessionID == sessionID {
			conn.ExpiresAt = expiresAt
		}
		conn.mu.Unlock()
	}
}

func (h *Hub) Send(userID string, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, connID := range h.userConns[userID] {
		conn := h.connections[connID]
		if conn == nil {
			continue
		}

		conn.mu.Lock()
		// The user index is keyed by userID, but verify the binding anyway:
		// a stale entry must never leak one user's events to another.
		if conn.UserID != userID {
			conn.mu.Unlock()

			continue
		}
		if !conn.Authorized || time.Now().After(conn.ExpiresAt) {
			conn.Authorized = false
			conn.mu.Unlock()

			continue
		}
		conn.mu.Unlock()

		select {
		case conn.Channel <- event:
		default:
			slog.Info("SSE channel full, dropping event", "userID", userID)
		}
	}
}

// sessionConnectionIDs returns the ids of the connections bound to sessionID.
func (h *Hub) sessionConnectionIDs(sessionID string) []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	conns := h.sessionConns[sessionID]
	ids := make([]string, 0, len(conns))
	for id := range conns {
		ids = append(ids, id)
	}

	return ids
}

// reapStaleUnauthenticatedLocked closes unauthenticated connections that
// never completed auth within hubAuthTimeout. Runs under the write lock.
func (h *Hub) reapStaleUnauthenticatedLocked(now time.Time) int {
	reaped := 0

	for id, conn := range h.connections {
		conn.mu.Lock()
		authorized := conn.Authorized
		created := conn.CreatedAt
		conn.mu.Unlock()

		if authorized || created.IsZero() {
			continue
		}

		if now.Sub(created) > hubAuthTimeout {
			close(conn.Channel)
			delete(h.connections, id)
			reaped++
		}
	}

	return reaped
}

// oldestUnauthenticatedLocked returns the id of the oldest unauthenticated
// connection, or "" when every connection is authenticated. Runs under the
// write lock.
func (h *Hub) oldestUnauthenticatedLocked() string {
	victim := ""
	var oldest time.Time

	for id, conn := range h.connections {
		conn.mu.Lock()
		authorized := conn.Authorized
		created := conn.CreatedAt
		conn.mu.Unlock()

		if authorized {
			continue
		}

		if victim == "" || created.Before(oldest) {
			victim, oldest = id, created
		}
	}

	return victim
}

func (h *Hub) cleanupLastTyping(cleanupInterval time.Duration) {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cutoff := time.Now().Add(-cleanupInterval)

			h.lastTyping.Range(func(k, v any) bool {
				ts, ok := v.(time.Time)
				if !ok || ts.Before(cutoff) {
					h.lastTyping.Delete(k)
				}

				return true
			})

		case <-h.closeCh:
			return
		}
	}
}
