// Package huma provides a Huma v2 pilot that runs alongside the existing
// stdlib HTTP transport. It mirrors the current SSE endpoint to validate the
// Huma integration before the full migration (Stage B).
package huma

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"fast_chat/config"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

// Pilot is a Huma v2 API that mirrors a subset of the existing HTTP transport.
type Pilot struct {
	mux *chi.Mux
}

// NewPilot builds a Huma API with the SSE endpoint registered. The returned
// http.Handler can be mounted on any path prefix next to the existing mux.
func NewPilot(hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config) *Pilot {
	mux := chi.NewMux()
	api := humachi.New(mux, huma.DefaultConfig("Fast Chat", "1.0.0"))

	p := &Pilot{mux: mux}
	p.registerSSE(api, hub, st, svc, cfg)

	return p
}

// Handler returns the underlying chi mux for mounting.
func (p *Pilot) Handler() http.Handler {
	return p.mux
}

func (p *Pilot) registerSSE(api huma.API, hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "sse",
		Method:      http.MethodGet,
		Path:        "/events",
		Summary:     "Server-sent events stream",
		Description: "Streams real-time events (messages, chat changes, typing) to the client via SSE.",
	}, func(ctx context.Context, input *sseInput) (*huma.StreamResponse, error) {
		return &huma.StreamResponse{
			Body: func(hctx huma.Context) {
				runSSE(ctx, hctx, hub, st, svc, cfg, input.ConnectionID)
			},
		}, nil
	})
}

type sseInput struct {
	ConnectionID string `doc:"Unique connection identifier" query:"connectionId"`
}

// runSSE mirrors the existing handler.SSE behavior: register a connection,
// write the connected event, then loop between heartbeats and hub events.
func runSSE(ctx context.Context, hctx huma.Context, hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config, connectionID string) {
	if connectionID == "" {
		hctx.SetStatus(http.StatusBadRequest)
		hctx.SetHeader("Content-Type", "application/json")
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"connectionId required"}`) //nolint:errcheck // best-effort: validation error before stream starts
		return
	}

	if len(connectionID) > 128 {
		hctx.SetStatus(http.StatusBadRequest)
		hctx.SetHeader("Content-Type", "application/json")
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"connectionId too long"}`) //nolint:errcheck // best-effort: validation error before stream starts
		return
	}

	writer := hctx.BodyWriter()
	flusher, ok := writer.(http.Flusher)
	if !ok {
		hctx.SetStatus(http.StatusInternalServerError)
		hctx.SetHeader("Content-Type", "application/json")
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"streaming unsupported"}`) //nolint:errcheck // best-effort: streaming unsupported
		return
	}

	hctx.SetHeader("Content-Type", "text/event-stream")
	hctx.SetHeader("Cache-Control", "no-cache")
	hctx.SetHeader("Connection", "keep-alive")
	hctx.SetHeader("Access-Control-Allow-Origin", cfg.CORS.Origin)
	hctx.SetStatus(http.StatusOK)

	writeEvent(writer, flusher, "connected", map[string]string{"status": "ok"})

	conn := hub.Register(connectionID)
	defer func() { //nolint:contextcheck // request context is cancelled by now, need fresh context.Background()
		hub.Unregister(connectionID, conn)
		conn.Lock()
		uid := conn.UserID
		conn.Unlock()

		if uid != "" && st.RemoveConnection(uid) {
			svc.BroadcastUserStatus(context.Background(), uid, false)
		}
	}()
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
				} else if remaining <= cfg.Auth.TokenExpiryWarning && !conn.Warned {
					conn.Warned = true
					warn = true
				}
			}

			expiresAt := conn.ExpiresAt
			conn.Unlock()

			if expired {
				writeEvent(writer, flusher, "token_expired", map[string]any{
					"message": "token expired",
				})

				return
			}

			if warn {
				writeEvent(writer, flusher, "token_expiring", map[string]any{
					"expiresAt": expiresAt.Format(time.RFC3339),
				})
			}

			writeComment(writer, flusher, "heartbeat")

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

			writeEvent(writer, flusher, evt.Event, evt.Data)
		}
	}
}

func writeEvent(w io.Writer, flusher http.Flusher, event string, data any) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return
	}

	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData) //nolint:errcheck // best-effort: SSE writer
	flusher.Flush()
}

func writeComment(w io.Writer, flusher http.Flusher, comment string) {
	fmt.Fprintf(w, ": %s\n\n", comment) //nolint:errcheck // best-effort: SSE writer
	flusher.Flush()
}
