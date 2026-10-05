// Package transport provides the Huma v2 HTTP API serving every /api/*
// domain. It sits in front of a small infra mux (health probes and the
// federation well-known endpoint) via the fallback handler.
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/ratelimit"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
)

// Transport is the Huma v2 HTTP API serving all migrated domains.
type Transport struct {
	mux *chi.Mux
}

// Deps carries the collaborators the Huma transport needs.
type Deps struct {
	Hub        *sse.Hub
	Store      *store.Store
	Svc        *service.Service
	Cfg        *config.Config
	FedManager *federation.Manager
	FedClient  *federation.Client
	// PushPublicKey reports the VAPID key; nil means push is not configured.
	PushPublicKey func() (string, bool)
	Version       string
	Commit        string
	RateLimiters  *RateLimiters
}

// New builds the Huma transport. The returned http.Handler must be wrapped by
// FallbackHandler to keep the infra mux (health probes, well-known)
// reachable.
func New(deps *Deps) *Transport {
	mux := chi.NewMux()

	if deps.RateLimiters != nil {
		mux.Use(rateLimitMiddleware(deps.RateLimiters))
	}

	// Mark genuine route misses so FallbackHandler can tell them apart from
	// migrated operations that legitimately answer 404/405.
	mux.NotFound(routeMiss(http.StatusNotFound))
	mux.MethodNotAllowed(routeMiss(http.StatusMethodNotAllowed))

	// Self-hosted API documentation (no third-party CDN).
	registerDocs(mux)

	humaConfig := newHumaConfig("Fast Chat", "1.0.0")
	// Body limits: Huma's per-operation default (1MB) matches the pre-migration
	// maxBody wrapper; the upload operation overrides it with MaxUploadSize.
	humaConfig.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		bearerScheme: {
			Type:         "http",
			Scheme:       "bearer",
			BearerFormat: "JWT",
		},
		federationScheme: {
			Type:        "apiKey",
			In:          "header",
			Name:        "X-Federation-Signature",
			Description: "Server-to-server federation HMAC signature",
		},
	}
	api := humachi.New(mux, humaConfig)
	api.UseMiddleware(AuthMiddleware(deps.Store))
	api.UseMiddleware(FederatedAuthMiddleware(deps.FedManager))
	api.UseMiddleware(requestStashMiddleware)

	cfg := deps.Cfg
	apiCfg := &APIConfig{
		DebugEmail: cfg.Email.DebugMode,
		Version:    deps.Version,
		Commit:     deps.Commit,
	}
	transport := &Transport{mux: mux}
	transport.registerSSE(api, deps.Hub, deps.Store, deps.Svc, cfg)
	RegisterAuth(api, deps.Svc, deps.Store, deps.Hub, apiCfg)
	RegisterUsers(api, deps.Store, deps.FedClient, cfg, apiCfg)
	RegisterPush(api, deps.Store, deps.PushPublicKey)
	RegisterChats(api, deps.Svc, deps.FedClient, cfg)
	RegisterMessages(api, deps.Svc, deps.Store, deps.FedClient, cfg)
	RegisterFiles(api, deps.Store, deps.Svc, cfg)
	RegisterSync(api, deps.Svc)
	RegisterFederated(api, deps.Store, deps.Svc, deps.FedManager, cfg)

	return transport
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
// reaches a Huma operation, mirroring the pre-migration per-route limiters.
// Non-matching routes pass through untouched.
//
// Request body size is capped by Huma's built-in MaxBodyBytes (1MB, matching
// the pre-migration maxBody wrapper); oversized bodies yield 413 instead of the
// pre-migration 400 — a documented deviation.
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
func (t *Transport) Handler() http.Handler {
	return t.mux
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

// FallbackHandler serves unmatched requests through the next handler (the
// infra mux with health probes and the well-known endpoint). Requests handled
// by a Huma operation never reach it.
func (t *Transport) FallbackHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := newFallbackBuffer(w)
		t.mux.ServeHTTP(buf, r)

		if buf.miss {
			// No Huma route matched — discard the buffered miss response and
			// let the infra mux serve the request from scratch.
			buf.flushUnsent(next, r)

			return
		}

		// Huma handled it — commit anything not already written (e.g. a
		// status-only response); streamed responses were already passed
		// through while the handler ran.
		buf.flush()
	})
}

// fallbackBuffer sits between Huma and the real ResponseWriter so the
// fallback decision can be made from the route-miss marker instead of the
// response status (a migrated operation may legitimately answer 404/405).
//
// It owns a separate header map so Huma's headers never leak into the
// response on fall-through. The body is NOT buffered: as soon as the response
// begins (first WriteHeader), the marker decides the fate — a route miss
// stays buffered (a tiny 404/405 body), anything else is replayed to the
// underlying writer immediately and every further write/flush passes through.
// This preserves incremental delivery for SSE, file downloads, and any other
// streaming response.
type fallbackBuffer struct {
	http.ResponseWriter
	header      http.Header
	buf         bytes.Buffer
	status      int
	wrote       bool
	miss        bool
	passthrough bool
}

func newFallbackBuffer(w http.ResponseWriter) *fallbackBuffer {
	return &fallbackBuffer{ResponseWriter: w, header: make(http.Header)}
}

func (f *fallbackBuffer) Header() http.Header {
	return f.header
}

func (f *fallbackBuffer) WriteHeader(code int) {
	if f.wrote {
		return
	}

	f.wrote = true
	f.status = code
	f.decide()
}

func (f *fallbackBuffer) Write(payload []byte) (int, error) {
	if !f.wrote {
		f.wrote = true
		f.status = http.StatusOK
		f.decide()
	}

	if f.passthrough {
		// Middleware passthrough: fallbackBuffer forwards handler-produced
		// responses (JSON/SSE/file streams) to the real writer and never renders
		// user input itself. codeql[go/reflected-xss]
		return f.ResponseWriter.Write(payload)
	}

	return f.buf.Write(payload)
}

// Flush forwards to the underlying flusher once streaming has begun; it is a
// no-op while still buffering (nothing reached the client yet).
func (f *fallbackBuffer) Flush() {
	if !f.passthrough {
		return
	}

	if ff, ok := f.ResponseWriter.(http.Flusher); ok {
		ff.Flush()
	}
}

// decide runs once, when the response begins. The route-miss marker is set by
// the router's NotFound/MethodNotAllowed handlers before they write, so it is
// reliable at this point.
func (f *fallbackBuffer) decide() {
	if f.header.Get(routeMissHeader) != "" {
		f.miss = true

		return
	}

	f.passthrough = true

	for key, values := range f.header {
		for _, value := range values {
			f.ResponseWriter.Header().Add(key, value)
		}
	}

	if f.status != 0 {
		f.ResponseWriter.WriteHeader(f.status)
	}

	if f.buf.Len() > 0 {
		_, _ = f.ResponseWriter.Write(f.buf.Bytes()) //nolint:errcheck // best-effort: committing buffered prefix
		f.buf.Reset()
	}
}

// flush commits a response that never started writing (e.g. status-only).
func (f *fallbackBuffer) flush() {
	if f.miss || f.passthrough {
		return
	}

	if f.status != 0 {
		f.ResponseWriter.WriteHeader(f.status)
	}

	_, _ = f.ResponseWriter.Write(f.buf.Bytes()) //nolint:errcheck // best-effort: committing buffered response
}

func (f *fallbackBuffer) flushUnsent(next http.Handler, r *http.Request) {
	// Nothing was written to the underlying writer; the next handler starts
	// with a clean slate (its own headers and status).
	next.ServeHTTP(f.ResponseWriter, r)
}

func (t *Transport) registerSSE(api huma.API, hub *sse.Hub, st *store.Store, svc *service.Service, cfg *config.Config) {
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
		hctx.SetHeader("Content-Type", "application/json")
		hctx.SetStatus(http.StatusBadRequest)
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"connectionId required"}`) //nolint:errcheck // best-effort: validation error before stream starts
		return
	}

	if len(connectionID) > 128 {
		hctx.SetHeader("Content-Type", "application/json")
		hctx.SetStatus(http.StatusBadRequest)
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"connectionId too long"}`) //nolint:errcheck // best-effort: validation error before stream starts
		return
	}

	writer := hctx.BodyWriter()
	flusher, ok := writer.(http.Flusher)
	if !ok {
		hctx.SetHeader("Content-Type", "application/json")
		hctx.SetStatus(http.StatusInternalServerError)
		_, _ = fmt.Fprint(hctx.BodyWriter(), `{"error":"streaming unsupported"}`) //nolint:errcheck // best-effort: streaming unsupported
		return
	}

	hctx.SetHeader("Content-Type", "text/event-stream")
	hctx.SetHeader("Cache-Control", "no-cache")
	hctx.SetHeader("Connection", "keep-alive")
	hctx.SetHeader("Access-Control-Allow-Origin", cfg.CORS.Origin)
	hctx.SetStatus(http.StatusOK)

	// Register the connection BEFORE writing the connected event (pre-migration
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

// --- Transport middleware ---

// federationScheme names the security scheme used by server-to-server
// federation endpoints.
const federationScheme = "federationSignature"

// federationTimestampToleranceSec bounds federation signature timestamps,
// matching the pre-migration transport.
const federationTimestampToleranceSec = 300

// maxFederatedBody caps the request body read while verifying an inbound
// federation signature, which happens before the signature is known to be
// valid and before any credential is presented.
const maxFederatedBody = 1 << 20

// requestContextKey stores the raw *http.Request/*http.ResponseWriter for
// operations that need direct request access (multipart uploads).
type (
	requestContextKey struct{}
	responseWriterKey struct{}
)

// requestFromContext retrieves the raw *http.Request stored by
// requestStashMiddleware.
func requestFromContext(ctx context.Context) (*http.Request, bool) {
	r, ok := ctx.Value(requestContextKey{}).(*http.Request)
	return r, ok && r != nil
}

// responseWriterFromContext retrieves the raw http.ResponseWriter stored by
// requestStashMiddleware.
func responseWriterFromContext(ctx context.Context) (http.ResponseWriter, bool) {
	w, ok := ctx.Value(responseWriterKey{}).(http.ResponseWriter)
	return w, ok && w != nil
}

// requestStashMiddleware stores the raw request and writer in the context so
// operations that need them (multipart upload) can retrieve them.
func requestStashMiddleware(ctx huma.Context, next func(huma.Context)) {
	r, w := humachi.Unwrap(ctx)
	next(huma.WithValue(huma.WithValue(ctx, requestContextKey{}, r), responseWriterKey{}, w))
}

// FederatedAuthMiddleware verifies federation signature headers on operations
// that declare the federation security scheme. On success the verified source
// server is stashed in the request context (mirroring the pre-migration middleware
// contract where handlers read X-Federation-Server directly).
func FederatedAuthMiddleware(fm *federation.Manager) func(ctx huma.Context, next func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		needsFed := false
		for _, scheme := range ctx.Operation().Security {
			if _, ok := scheme[federationScheme]; ok {
				needsFed = true
				break
			}
		}

		if !needsFed {
			next(ctx)

			return
		}

		r, w := humachi.Unwrap(ctx)

		switch verified, tooLarge := verifyFederatedRequest(fm, w, r); {
		case tooLarge:
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusRequestEntityTooLarge)
			_, _ = fmt.Fprintf(ctx.BodyWriter(), `{"error":"request body too large"}`) //nolint:errcheck // best-effort: rejection

			return
		case !verified:
			ctx.SetHeader("Content-Type", "application/json")
			ctx.SetStatus(http.StatusUnauthorized)
			_, _ = fmt.Fprintf(ctx.BodyWriter(), `{"error":"unauthorized"}`) //nolint:errcheck // best-effort: auth rejection

			return
		}

		next(huma.WithValue(ctx, federatedServerKey{}, r.Header.Get("X-Federation-Server")))
	}
}

// verifyFederatedRequest checks federation headers, timestamp tolerance, and
// the request signature, capping the signature body at 10 MiB. It mirrors
// handler.VerifyFederatedRequest minus the response writing (the transport
// owns the wire response). tooLarge reports a body over the cap so the caller
// can answer 413 like the pre-migration transport.
func verifyFederatedRequest(fm *federation.Manager, w http.ResponseWriter, r *http.Request) (bool, bool) {
	serverDomain := r.Header.Get("X-Federation-Server")
	signature := r.Header.Get("X-Federation-Signature")
	timestampStr := r.Header.Get("X-Federation-Timestamp")

	if serverDomain == "" || signature == "" || timestampStr == "" {
		return false, false
	}

	timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
	if err != nil {
		return false, false
	}

	now := time.Now().Unix()
	if now-timestamp > federationTimestampToleranceSec || timestamp-now > federationTimestampToleranceSec {
		return false, false
	}

	// This read happens before the signature is checked, so the cap is what
	// bounds memory for an anonymous request naming any host. A federated
	// message carries at most MaxMessageLen of text plus MaxEncryptedPayloadLen
	// of ciphertext, so 1 MiB — the same cap Huma applies to these routes
	// afterwards — leaves an order of magnitude of headroom.
	r.Body = http.MaxBytesReader(w, r.Body, maxFederatedBody)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		return false, true
	}

	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	if !fm.Verify(r.Context(), serverDomain, signature, r.Method, r.URL.RequestURI(), bodyBytes, timestamp) {
		return false, false
	}

	return true, false
}

// federatedServerKey stores the verified remote server domain.
type federatedServerKey struct{}

// federatedServerFromContext returns the verified remote server domain.
func federatedServerFromContext(ctx context.Context) string {
	if domain, ok := ctx.Value(federatedServerKey{}).(string); ok {
		return domain
	}

	return ""
}
