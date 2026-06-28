package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	sseHeartbeatInterval = 30 * time.Second
	sseChannelBuffer     = 128
)

type SSEEvent struct {
	Event string
	Data  any
}

type SSEConnection struct {
	mu         sync.Mutex
	ID         string
	UserID     string
	Token      string
	ExpiresAt  time.Time
	Authorized bool
	warned     bool
	Channel    chan SSEEvent
}

type SSEHub struct {
	mu          sync.RWMutex
	connections map[string]*SSEConnection // connectionID -> conn
	userConns   map[string][]string       // userID -> []connectionID
	lastTyping  sync.Map
	closeCh     chan struct{}
}

func NewSSEHub() *SSEHub {
	hub := &SSEHub{
		connections: make(map[string]*SSEConnection),
		userConns:   make(map[string][]string),
		closeCh:     make(chan struct{}),
	}
	go hub.cleanupLastTyping()
	return hub
}

func (h *SSEHub) Close() {
	select {
	case <-h.closeCh:
	default:
		close(h.closeCh)
	}
}

func (h *SSEHub) cleanupLastTyping() {
	ticker := time.NewTicker(typingThrottleInterval * 5)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cutoff := time.Now().Add(-typingThrottleInterval * 5)
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

func (h *SSEHub) Register(connectionID string) *SSEConnection {
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

	conn := &SSEConnection{
		ID:      connectionID,
		Channel: make(chan SSEEvent, sseChannelBuffer),
	}
	h.connections[connectionID] = conn
	return conn
}

func (h *SSEHub) Unregister(connectionID string) {
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

func (h *SSEHub) GetConnection(connectionID string) *SSEConnection {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connections[connectionID]
}

func (h *SSEHub) Authenticate(connectionID, userID, token string, expiresAt time.Time) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.connections[connectionID]
	if !ok {
		return fmt.Errorf("connection not found")
	}

	conn.mu.Lock()
	conn.UserID = userID
	conn.Token = token
	conn.ExpiresAt = expiresAt
	conn.Authorized = true
	conn.warned = false
	conn.mu.Unlock()

	h.userConns[userID] = append(h.userConns[userID], connectionID)
	return nil
}

func (h *SSEHub) Send(userID string, event SSEEvent) {
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

func (h *Handler) SSE(w http.ResponseWriter, r *http.Request) {
	connectionID := r.URL.Query().Get("connectionId")
	if connectionID == "" {
		http.Error(w, "connectionId required", http.StatusBadRequest)
		return
	}

	conn := h.hub.Register(connectionID)
	defer func() {
		h.hub.Unregister(connectionID)
		conn.mu.Lock()
		uid := conn.UserID
		conn.mu.Unlock()
		if uid != "" {
			h.store.RemoveConnection(uid)
		}
	}()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", h.cfg.CORS.Origin)

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck
	flusher.Flush()

	ctx := r.Context()
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			expired := false
			warn := false

			conn.mu.Lock()
			if conn.Authorized {
				remaining := time.Until(conn.ExpiresAt)
				if remaining <= 0 {
					conn.Authorized = false
					expired = true
				} else if remaining <= h.cfg.Auth.TokenExpiryWarning && !conn.warned {
					conn.warned = true
					warn = true
				}
			}
			expiresAt := conn.ExpiresAt
			conn.mu.Unlock()

			if expired {
				sendSSE(w, flusher, "token_expired", map[string]any{
					"message": "token expired",
				})
				return
			}
			if warn {
				sendSSE(w, flusher, "token_expiring", map[string]any{
					"expiresAt": expiresAt.Format(time.RFC3339),
				})
			}

			if _, err := fmt.Fprintf(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()

		case evt, ok := <-conn.Channel:
			if !ok {
				return
			}

			conn.mu.Lock()
			authorized := conn.Authorized
			conn.mu.Unlock()
			if !authorized {
				continue
			}

			sendSSE(w, flusher, evt.Event, evt.Data)
		}
	}
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, event string, data any) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return
	}

	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData); err != nil {
		return
	}
	flusher.Flush()
}
