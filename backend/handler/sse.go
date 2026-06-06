package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sseHeartbeatInterval = 30 * time.Second
	sseChannelBuffer     = 128
)

type SSEEvent struct {
	Event string
	Data  interface{}
}

type SSEHub struct {
	mu         sync.RWMutex
	clients    map[string][]chan SSEEvent
	lastTyping sync.Map // key "chatID:userID" → time.Time
	closeCh    chan struct{}
}

func NewSSEHub() *SSEHub {
	hub := &SSEHub{
		clients: make(map[string][]chan SSEEvent),
		closeCh: make(chan struct{}),
	}
	go hub.cleanupLastTyping()

	return hub
}

// Close stops the hub's background goroutines.
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

func (h *SSEHub) Subscribe(userID string) chan SSEEvent {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan SSEEvent, sseChannelBuffer)
	h.clients[userID] = append(h.clients[userID], ch)

	return ch
}

func (h *SSEHub) Unsubscribe(userID string, ch chan SSEEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()

	channels := h.clients[userID]
	for i, c := range channels {
		if c == ch {
			close(c)

			h.clients[userID] = append(channels[:i], channels[i+1:]...)

			break
		}
	}

	if len(h.clients[userID]) == 0 {
		delete(h.clients, userID)
	}
}

func (h *SSEHub) Send(userID string, event SSEEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, ch := range h.clients[userID] {
		select {
		case ch <- event:
		default:
			log.Printf("SSE channel full for user %s, dropping event", userID) //nolint:gosec // userID is a system-generated UUID
		}
	}
}

func (h *Handler) SSE(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	token = strings.TrimPrefix(token, "Bearer ")

	if token == "" {
		token = r.URL.Query().Get("token")
	}

	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)

		return
	}

	user, ok := h.store.GetUserByToken(token)
	if !ok {
		http.Error(w, errKeyUnauthorized, http.StatusUnauthorized)

		return
	}

	h.store.AddConnection(user.ID)

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.store.RemoveConnection(user.ID)
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)

		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", h.cfg.CORSOrigin)

	ch := h.hub.Subscribe(user.ID)

	defer func() {
		h.hub.Unsubscribe(user.ID, ch)
		h.store.RemoveConnection(user.ID)
	}()

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck

	flusher.Flush()

	ctx := r.Context()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := fmt.Fprintf(w, ": heartbeat\n\n"); err != nil { //nolint:errcheck
				return
			}

			flusher.Flush()

		case evt, ok := <-ch:
			if !ok {
				return
			}

			data, marshalErr := json.Marshal(evt.Data)
			if marshalErr != nil {
				continue
			}

			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Event, data); err != nil { //nolint:errcheck
				return
			}

			flusher.Flush()
		}
	}
}
