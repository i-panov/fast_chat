// Package huma provides a Huma v2 pilot that runs alongside the existing
// stdlib HTTP transport. It mirrors the current SSE endpoint to validate the
// Huma integration before the full migration (Stage B).
package huma

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"fast_chat/config"
	"fast_chat/ratelimit"
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
func NewPilot(hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config, rl *RateLimiters) *Pilot {
	mux := chi.NewMux()

	if rl != nil {
		mux.Use(rateLimitMiddleware(rl))
	}

	// Mark genuine route misses so FallbackHandler can tell them apart from
	// migrated operations that legitimately answer 404/405.
	mux.NotFound(routeMiss(http.StatusNotFound))
	mux.MethodNotAllowed(routeMiss(http.StatusMethodNotAllowed))

	humaConfig := newHumaConfig("Fast Chat", "1.0.0")
	humaConfig.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		bearerScheme: {
			Type:         "http",
			Scheme:       "bearer",
			BearerFormat: "JWT",
		},
	}
	api := humachi.New(mux, humaConfig)
	api.UseMiddleware(AuthMiddleware(st))

	p := &Pilot{mux: mux}
	p.registerSSE(api, hub, st, svc, cfg)
	RegisterAuth(api, svc, st, hub, &APIConfig{DebugEmail: cfg.Email.DebugMode})

	return p
}

// RateLimiters holds per-route rate limiters for auth endpoints.
type RateLimiters struct {
	Extractor  *ratelimit.ClientIPExtractor
	SendCode   *ratelimit.RateLimiter
	VerifyCode *ratelimit.RateLimiter
	Register   *ratelimit.RateLimiter
	SSEAuth    *ratelimit.RateLimiter
}

// rateLimitMiddleware applies route-specific rate limits before the request
// reaches a Huma operation, mirroring the legacy per-route limiters.
// Non-matching routes pass through untouched.
//
// Request body size is capped by Huma's built-in MaxBodyBytes (1MB, matching
// the legacy maxBody wrapper); oversized bodies yield 413 instead of the
// legacy 400 — a documented deviation.
func rateLimitMiddleware(rl *RateLimiters) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var limiter *ratelimit.RateLimiter

			if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/auth/") {
				switch r.URL.Path {
				case "/api/auth/send-code":
					limiter = rl.SendCode
				case "/api/auth/verify-code":
					limiter = rl.VerifyCode
				case "/api/auth/complete-registration":
					limiter = rl.Register
				case "/api/auth/sse-auth":
					limiter = rl.SSEAuth
				}
			}

			if limiter != nil {
				ip := rl.Extractor.ClientIP(r)
				if !limiter.Allow(ip) {
					http.Error(w, "too many requests", http.StatusTooManyRequests)
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Handler returns the underlying chi mux for mounting.
func (p *Pilot) Handler() http.Handler {
	return p.mux
}

// routeMissHeader marks responses produced by chi's NotFound/MethodNotAllowed
// handlers — the only reliable "no Huma route matched" signal. Response
// status alone is not: migrated operations may legitimately answer 404/405
// (e.g. unknown SSE connection ID).
const routeMissHeader = "X-Huma-Route-Miss"

func routeMiss(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set(routeMissHeader, "1")
		http.Error(w, http.StatusText(status), status)
	}
}

// FallbackHandler wraps the Huma pilot so that requests not handled by any
// Huma operation fall through to the next handler (e.g. the stdlib mux). This
// enables incremental migration: migrated domains are served by Huma while
// unmigrated ones keep using the legacy transport.
//
// SSE streams (/api/events) are never buffered — they pass through directly to
// avoid breaking incremental delivery of events.
func (p *Pilot) FallbackHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// SSE streams must not be buffered; pass through directly.
		if r.URL.Path == "/api/events" {
			p.mux.ServeHTTP(w, r)

			return
		}

		buf := newFallbackBuffer(w)
		p.mux.ServeHTTP(buf, r)

		if buf.header.Get(routeMissHeader) != "" {
			// No Huma route matched — discard the buffered miss response and
			// let the legacy transport serve the request from scratch.
			buf.flushUnsent(next, r)

			return
		}

		// Huma handled it — replay the captured response.
		buf.flush()
	})
}

// fallbackBuffer intercepts writes so the response can be inspected (route
// miss marker) before it reaches the client. It owns a separate header map so
// Huma's headers never leak into the legacy response on fall-through.
type fallbackBuffer struct {
	http.ResponseWriter
	header http.Header
	buf    bytes.Buffer
	status int
	wrote  bool
}

func newFallbackBuffer(w http.ResponseWriter) *fallbackBuffer {
	return &fallbackBuffer{ResponseWriter: w, header: make(http.Header)}
}

func (f *fallbackBuffer) Header() http.Header {
	return f.header
}

func (f *fallbackBuffer) WriteHeader(code int) {
	if !f.wrote {
		f.status = code
		f.wrote = true
	}
}

func (f *fallbackBuffer) Write(payload []byte) (int, error) {
	if !f.wrote {
		f.status = http.StatusOK
		f.wrote = true
	}

	return f.buf.Write(payload)
}

// Flush ensures http.Flusher is satisfied for streaming responses.
func (f *fallbackBuffer) Flush() {
	if ff, ok := f.ResponseWriter.(http.Flusher); ok {
		ff.Flush()
	}
}

func (f *fallbackBuffer) flush() {
	for key, values := range f.header {
		for _, value := range values {
			f.ResponseWriter.Header().Add(key, value)
		}
	}

	if f.status != 0 {
		f.ResponseWriter.WriteHeader(f.status)
	}

	_, _ = f.ResponseWriter.Write(f.buf.Bytes()) //nolint:errcheck // best-effort: flushing buffered Huma response
}

func (f *fallbackBuffer) flushUnsent(next http.Handler, r *http.Request) {
	// Nothing was written to the underlying writer; the legacy handler starts
	// with a clean slate (its own headers and status).
	next.ServeHTTP(f.ResponseWriter, r)
}

func (p *Pilot) registerSSE(api huma.API, hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config) {
	huma.Register(api, huma.Operation{
		OperationID: "sse",
		Method:      http.MethodGet,
		Path:        "/api/events",
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

	// Register the connection BEFORE writing the connected event (legacy
	// parity): the client reacts to connected by calling /api/auth/sse-auth,
	// which would 404 if the connection is not registered yet.
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

	writeEvent(writer, flusher, "connected", map[string]string{"status": "ok"})

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
