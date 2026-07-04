package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"fast_chat/sse"
)

func (h *Handler) SSE(w http.ResponseWriter, r *http.Request) {
	connectionID := r.URL.Query().Get("connectionId")
	if connectionID == "" {
		writeError(w, http.StatusBadRequest, "connectionId required")
		return
	}

	if len(connectionID) > 128 {
		writeError(w, http.StatusBadRequest, "connectionId too long")
		return
	}

	conn := h.hub.Register(connectionID)
	defer func() {
		h.hub.Unregister(connectionID)
		conn.Lock()
		uid := conn.UserID
		conn.Unlock()

		if uid != "" {
			h.store.RemoveConnection(uid)
		}
	}()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", h.cfg.CORS.Origin)

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck

	flusher.Flush()

	ctx := r.Context()

	heartbeat := time.NewTicker(sse.HeartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			expired := false
			warn := false

			conn.Lock()
			if conn.Authorized {
				remaining := time.Until(conn.ExpiresAt)
				if remaining <= 0 {
					conn.Authorized = false
					expired = true
				} else if remaining <= h.cfg.Auth.TokenExpiryWarning && !conn.Warned {
					conn.Warned = true
					warn = true
				}
			}

			expiresAt := conn.ExpiresAt
			conn.Unlock()

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

			conn.Lock()
			authorized := conn.Authorized
			conn.Unlock()

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
