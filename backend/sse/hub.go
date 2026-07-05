// Package sse provides a Server-Sent Events hub for real-time messaging.
package sse

import (
	"errors"
	"log/slog"
	"sync"
	"time"
)

const (
	HeartbeatInterval = 30 * time.Second
	channelBuffer     = 128
)

type Event struct {
	Event string
	Data  any
}

type Connection struct {
	mu         sync.Mutex
	ID         string
	UserID     string
	Token      string
	ExpiresAt  time.Time
	Authorized bool
	Warned     bool
	Channel    chan Event
}

func (c *Connection) Lock()   { c.mu.Lock() }
func (c *Connection) Unlock() { c.mu.Unlock() }

type Hub struct {
	mu          sync.RWMutex
	connections map[string]*Connection
	userConns   map[string][]string
	lastTyping  sync.Map
	closeCh     chan struct{}
}

func NewHub(cleanupInterval time.Duration) *Hub {
	hub := &Hub{
		connections: make(map[string]*Connection),
		userConns:   make(map[string][]string),
		closeCh:     make(chan struct{}),
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

	conn := &Connection{
		ID:      connectionID,
		Channel: make(chan Event, channelBuffer),
	}
	h.connections[connectionID] = conn

	return conn
}

func (h *Hub) Unregister(connectionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.connections[connectionID]
	if !ok {
		return
	}

	close(conn.Channel)
	delete(h.connections, connectionID)

	if conn.UserID != "" {
		conns := h.userConns[conn.UserID]
		for i, c := range conns {
			if c == connectionID {
				h.userConns[conn.UserID] = append(conns[:i], conns[i+1:]...)
				break
			}
		}

		if len(h.userConns[conn.UserID]) == 0 {
			delete(h.userConns, conn.UserID)
		}
	}
}

func (h *Hub) GetConnection(connectionID string) *Connection {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return h.connections[connectionID]
}

func (h *Hub) Authenticate(connectionID, userID, token string, expiresAt time.Time) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.connections[connectionID]
	if !ok {
		return errors.New("connection not found")
	}

	conn.mu.Lock()
	conn.UserID = userID
	conn.Token = token
	conn.ExpiresAt = expiresAt
	conn.Authorized = true
	conn.Warned = false
	conn.mu.Unlock()

	h.userConns[userID] = append(h.userConns[userID], connectionID)

	return nil
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
