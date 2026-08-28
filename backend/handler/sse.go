package handler

import (
	"context"
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
	defer func() { //nolint:contextcheck // request context is cancelled by now, need fresh context.Background()
		h.hub.Unregister(connectionID, conn)
		conn.Lock()
		uid := conn.UserID
		conn.Unlock()

		if uid != "" {
			if h.store.RemoveConnection(uid) {
				h.broadcastUserStatus(context.Background(), uid, false)
			}
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

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck // best-effort: failure is not actionable

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

	// SSE frames are JSON-encoded and consumed via fetch, not parsed as
	// HTML, so raw Fprintf framing is the intended format (not XSS).
	// nosemgrep: no-fprintf-to-responsewriter
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData); err != nil {
		return
	}

	flusher.Flush()
}
