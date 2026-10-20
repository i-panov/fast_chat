package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/internal/httputil"
	"fast_chat/push"
	"fast_chat/ratelimit"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
	"fast_chat/transport"
)

const (
	// federationOutboxInterval is how often the queued federation operations
	// are delivered to their peers.
	federationOutboxInterval = 5 * time.Second
	// federationCatchupInterval is how often the peers are polled for the
	// messages they have for this server.
	federationCatchupInterval = 30 * time.Second
)

func corsMiddleware(origin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)

				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// contentSecurityPolicy is the policy of the served interface.
//
// The script and the style sources stay on the server: the interface is a
// bundled application, it loads no third-party code. The style attribute is
// allowed because the component library sets inline styles. The map tiles
// come from the OpenStreetMap servers, and blob:/data: cover the object
// URLs of the decrypted attachments and the inline images.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https://*.tile.openstreetmap.org; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"manifest-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

func securityHeadersMiddleware(ipExtractor *ratelimit.ClientIPExtractor) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("X-XSS-Protection", "0")
			w.Header().Set("Content-Security-Policy", contentSecurityPolicy)

			// The header is only meaningful on a secure connection. The
			// typical deployment terminates TLS at a reverse proxy, so the
			// scheme is taken from the header of a trusted proxy.
			if requestIsHTTPS(r, ipExtractor) {
				w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}

			next.ServeHTTP(w, r)
		})
	}
}

// requestIsHTTPS reports whether the request reached the server over TLS.
//
// Behind a reverse proxy the TLS connection ends at the proxy and the server
// sees plain HTTP, so the scheme comes from X-Forwarded-Proto. The header is
// only believed when the direct peer is a configured proxy: otherwise a client
// could claim a secure connection it does not have.
func requestIsHTTPS(r *http.Request, ipExtractor *ratelimit.ClientIPExtractor) bool {
	if r.TLS != nil {
		return true
	}

	if !ipExtractor.IsTrustedProxy(r) {
		return false
	}

	proto := r.Header.Get("X-Forwarded-Proto")
	if idx := strings.Index(proto, ","); idx >= 0 {
		proto = proto[:idx]
	}

	return strings.EqualFold(strings.TrimSpace(proto), "https")
}

func rateLimitMiddleware(rl *ratelimit.RateLimiter, ipExtractor *ratelimit.ClientIPExtractor) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := ipExtractor.ClientIP(r)
			if !rl.Allow(ip) {
				http.Error(w, "too many requests", http.StatusTooManyRequests)

				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// requestLogMiddleware records method, path, status, duration, and client IP for
// every request. It logs at Info level for success (status < 400) and Warn for
// client/server errors, giving operators a complete traffic trail via slog.
func requestLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Capture the response status without buffering the whole body.
		wrapped := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(wrapped, r)

		elapsed := time.Since(start)
		id := httputil.GetRequestID(r.Context())

		level := slog.LevelInfo
		if wrapped.status >= http.StatusBadRequest {
			level = slog.LevelWarn
		}

		slog.LogAttrs(
			r.Context(),
			level,
			"request completed",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", wrapped.status),
			slog.Duration("duration", elapsed),
			slog.String("remote_addr", r.RemoteAddr),
			slog.String("request_id", id),
		)
	})
}

// statusWriter intercepts WriteHeader calls so the middleware can read the final
// status code after the handler has finished.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Write ensures the status defaults to 200 if the handler only wrote a body
// without an explicit WriteHeader — otherwise we'd log status 0.
func (s *statusWriter) Write(payload []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}

	// Middleware passthrough: the body is produced by downstream handlers (JSON
	// via httputil.WriteJSON or file streaming); this wrapper only forwards
	// bytes so status logging sees them. codeql[go/reflected-xss]
	return s.ResponseWriter.Write(payload)
}

// Flush forwards flush calls to the underlying writer. Without this, handlers
// that type-assert http.Flusher (the SSE stream does) would break behind the
// logging middleware.
func (s *statusWriter) Flush() {
	if s.status == 0 {
		s.status = http.StatusOK
	}

	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// newHumaTransport mounts the Huma v2 transport (all /api/* domains) in front
// of the infra mux and returns the combined handler. Only health probes and
// the federation well-known endpoint live on the infra mux.
func newTransport(
	infraMux *http.ServeMux,
	hub *sse.Hub,
	st *store.Store,
	svc *service.Service,
	cfg *config.Config,
	fedManager *federation.Manager,
	fedClient *federation.Client,
	pushService *push.Service,
	ipExtractor *ratelimit.ClientIPExtractor,
	rl *limiters,
) http.Handler {

	humaAPI := transport.New(&transport.Deps{
		Hub:           hub,
		Store:         st,
		Svc:           svc,
		Cfg:           cfg,
		FedManager:    fedManager,
		FedClient:     fedClient,
		PushPublicKey: func() (string, bool) { return pushService.PublicKey(), true },
		Version:       version,
		Commit:        commit,
		RateLimiters: &transport.RateLimiters{
			Extractor:  ipExtractor,
			SendCode:   rl.sendCode,
			VerifyCode: rl.verifyCode,
			Register:   rl.register,
			SSEAuth:    rl.sseAuth,
		},
	})

	return humaAPI.FallbackHandler(infraMux)
}

// registerRoutes wires the infra routes (health probes, federation
// well-known) onto the mux.
// keyStatus is the shared health-probe JSON key.
const keyStatus = "status"

func registerRoutes(
	mux *http.ServeMux,
	fedManager *federation.Manager,
	st *store.Store,
) {

	// Health probes: no auth and no per-route rate limiter (used by
	// orchestrators). The global rl.general still applies at the outer layer.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		httputil.WriteJSON(w, http.StatusOK, map[string]string{keyStatus: "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if err := st.Ping(); err != nil {
			slog.Error("readiness check failed", "err", err)
			httputil.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
				keyStatus: "error",
				"message": "database unavailable",
			})

			return
		}

		httputil.WriteJSON(w, http.StatusOK, map[string]string{keyStatus: "ready"})
	})

	// All /api/* domains are served by the Huma v2 transport (see humaAPI):
	// auth, SSE, config, users/keys, push, chats, messages, threads, files,
	// typing, sync, and the federated server-to-server endpoints.

	// Well-known endpoint (no auth, public key for federation)
	mux.HandleFunc("GET /.well-known/fast-chat", fedManager.WellKnownHandler)
}

var (
	version = "dev"
	commit  = "none"
)

func main() {
	configPath := flag.String("config", "", "path to config file (required)")
	showVersion := flag.Bool("version", false, "print version and exit")

	flag.Parse()

	if *showVersion {
		fmt.Fprintf(os.Stdout, "fastchat %s (commit %s)\n", version, commit) //nolint:errcheck // best-effort: failure is not actionable
		os.Exit(0)
	}

	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "FATAL: --config flag is required")
		os.Exit(1)
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Failed to load config: %v\n", err)
		os.Exit(1)
	}

	// Directory mode is deliberate least privilege: 0700/0750 gives the owner
	// rwx (or r-x for group) on a directory; anything below strips the execute
	// bit and breaks path traversal. The rule targets file modes.
	// nosemgrep: go.lang.correctness.permissions.incorrect-default-permission
	if err := os.MkdirAll(filepath.Dir(cfg.Database.Path), 0o750); err != nil {
		slog.Error("failed to create data directory", "err", err)
		os.Exit(1)
	}

	// Directory mode is deliberate least privilege: 0700/0750 gives the owner
	// rwx (or r-x for group) on a directory; anything below strips the execute
	// bit and breaks path traversal. The rule targets file modes.
	// nosemgrep: go.lang.correctness.permissions.incorrect-default-permission
	if err := os.MkdirAll(cfg.Uploads.Dir, 0o750); err != nil {
		slog.Error("failed to create upload directory", "err", err)
		os.Exit(1)
	}

	// Directory mode is deliberate least privilege: 0700/0750 gives the owner
	// rwx (or r-x for group) on a directory; anything below strips the execute
	// bit and breaks path traversal. The rule targets file modes.
	// nosemgrep: go.lang.correctness.permissions.incorrect-default-permission
	if err := os.MkdirAll(cfg.Push.KeyPath, 0o700); err != nil {
		slog.Error("failed to create push keys directory", "err", err)
		os.Exit(1)
	}

	db, err := store.InitDB(cfg.Database.Path)
	if err != nil {
		slog.Error("failed to initialize database", "err", err)
		os.Exit(1)
	}

	fedKey, err := federation.LoadOrGenerateKeys(cfg.Federation.KeyPath)
	if err != nil {
		slog.Error("failed to load federation keys", "err", err)
		os.Exit(1)
	}

	fedManager := federation.New(fedKey, cfg.Server.Domain, cfg.Federation.Scheme, cfg.Federation.Timeout, cfg.Federation.AllowPrivateAddresses)

	st := store.New(db)
	st.Codes().StartCleanup(context.Background(), time.Minute)

	onPushExpired := func(endpoint string) {
		slog.Info("removing expired push subscription", "endpoint", endpoint)

		if err := st.DeletePushSubscriptionByEndpoint(context.Background(), endpoint); err != nil {
			slog.Warn("failed to remove expired push subscription", "err", err)
		}
	}

	pushService, err := push.NewService(cfg.Push.VAPIDSubject, cfg.Push.KeyPath, onPushExpired)
	if err != nil {
		slog.Error("failed to initialize push service", "err", err)
		os.Exit(1)
	}

	hub := sse.NewHub(service.TypingThrottleInterval * 5)
	svc := service.New(st, cfg, hub, pushService)
	fedClient := federation.NewClient(fedManager, cfg.Server.Domain, cfg.Federation.Scheme, cfg.Federation.Timeout, cfg.Federation.AllowPrivateAddresses)

	// The federation operations are queued in the database and delivered by a
	// worker: an operation that cannot be delivered right now is retried
	// until the peer accepts it, instead of being lost with the request.
	fedClient.SetOutbox(st)
	svc.SetFederationClient(fedClient)

	workerCtx, stopWorkers := context.WithCancel(context.Background())

	var workers sync.WaitGroup

	workers.Go(func() {
		fedClient.RunOutbox(workerCtx, federationOutboxInterval)
	})

	workers.Go(func() {
		svc.RunFederationCatchup(workerCtx, federationCatchupInterval)
	})

	ipExtractor := ratelimit.NewClientIPExtractor(cfg.Server.TrustedProxies)

	rl := newLimiters(cfg)

	mux := http.NewServeMux()
	registerRoutes(mux, fedManager, st)

	// The Huma v2 transport serves every /api/* domain; only health probes
	// and the well-known endpoint remain on the infra mux.
	humaAPI := newTransport(mux, hub, st, svc, cfg, fedManager, fedClient,
		pushService, ipExtractor, rl)

	// Static file serving for production frontend build
	absStaticDir := resolveStaticDir(cfg.Server.StaticDir)

	server := newHTTPServer(cfg, humaAPI, absStaticDir, rl.general, ipExtractor)

	serveErr := runServer(shutdownDeps{
		server:      server,
		hub:         hub,
		fedManager:  fedManager,
		fedClient:   fedClient,
		store:       st,
		limiters:    rl,
		budget:      30 * time.Second,
		stopWorkers: stopWorkers,
		workers:     &workers,
	})
	if serveErr != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", serveErr)
		os.Exit(1)
	}
}

// newHTTPServer builds the server with the middleware chain: the request id
// and the access log on the outside, then the security headers, the CORS
// answer, the global rate limit and the application itself.
func newHTTPServer(
	cfg *config.Config,
	handler http.Handler,
	staticDir string,
	generalLimiter *ratelimit.RateLimiter,
	ipExtractor *ratelimit.ClientIPExtractor,
) *http.Server {

	return &http.Server{
		Addr: fmt.Sprintf(":%d", cfg.Server.Port),
		Handler: httputil.RequestIDMiddleware(
			requestLogMiddleware(
				securityHeadersMiddleware(ipExtractor)(
					corsMiddleware(cfg.CORS.Origin)(
						rateLimitMiddleware(generalLimiter, ipExtractor)(
							spaFallbackMiddleware(staticDir)(handler),
						),
					),
				),
			),
		),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
}

// limiters groups the rate limiters from creation to teardown. They travel
// together and five of the entries share one type, so passing them as a
// positional list would let a misordering compile and close the wrong limiter.
type limiters struct {
	general    *ratelimit.RateLimiter
	sendCode   *ratelimit.RateLimiter
	verifyCode *ratelimit.RateLimiter
	register   *ratelimit.RateLimiter
	sseAuth    *ratelimit.RateLimiter
}

func newLimiters(cfg *config.Config) *limiters {
	return &limiters{
		general:    ratelimit.New(cfg.RateLimits.General.Limit, cfg.RateLimits.General.Window, 10000),
		sendCode:   ratelimit.New(cfg.RateLimits.SendCode.Limit, cfg.RateLimits.SendCode.Window, 10000),
		verifyCode: ratelimit.New(cfg.RateLimits.VerifyCode.Limit, cfg.RateLimits.VerifyCode.Window, 10000),
		register:   ratelimit.New(cfg.RateLimits.Register.Limit, cfg.RateLimits.Register.Window, 10000),
		sseAuth:    ratelimit.New(60, time.Minute, 10000),
	}
}

// closeAll stops every limiter's background cleanup. Called once, at shutdown.
func (l *limiters) closeAll() {
	l.general.Close()
	l.sendCode.Close()
	l.verifyCode.Close()
	l.register.Close()
	l.sseAuth.Close()
}

// shutdownDeps carries everything the shutdown sequence needs. The order of
// shutdown depends on it, so the fields are named: a positional list of twelve
// arguments, five of them the same type, is easy to get wrong silently.
type shutdownDeps struct {
	server     *http.Server
	hub        *sse.Hub
	fedManager *federation.Manager
	fedClient  *federation.Client
	store      *store.Store
	limiters   *limiters
	budget     time.Duration
	// stopWorkers cancels the background workers, workers waits for them to
	// finish. They touch the database, so they have to be stopped before the
	// store is closed.
	stopWorkers context.CancelFunc
	workers     *sync.WaitGroup
}

// runServer blocks until SIGINT/SIGTERM, then tears everything down.
//
// A failure to bind is returned rather than logged: the caller cannot do
// anything useful with a process that never served a request but is still
// running, holding the SQLite file and reporting a live PID to whatever
// supervises it. Signalling is what ends this, and a container that gets
// SIGTERM on a failed deploy would otherwise look like a healthy start.
func runServer(deps shutdownDeps) error {
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	return serveUntilSignal(deps.server.ListenAndServe, deps, quit)
}

// serveUntilSignal runs the listener and returns once a signal arrives or the
// listener fails. Either way it tears down first, so a bind failure releases the
// resources that were already acquired.
//
// serve is a parameter so a test can drive a real listener it controls,
// instead of racing for a free port.
func serveUntilSignal(serve func() error, deps shutdownDeps, quit <-chan os.Signal) error {
	slog.Info("server starting", "addr", deps.server.Addr)

	serveErr := make(chan error, 1)

	go func() {
		if err := serve(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err

			return
		}

		// The listener closed without an error: Shutdown was called.
		serveErr <- nil
	}()

	var serveFailure error

	select {
	case <-quit:
		slog.Info("shutdown signal received")
	case serveFailure = <-serveErr:
		slog.Error("server stopped before serving", "err", serveFailure)
	}

	shutdown(deps, context.Background())

	if serveFailure != nil {
		return fmt.Errorf("listen on %s: %w", deps.server.Addr, serveFailure)
	}

	return nil
}

// shutdown drains in-flight work and releases resources. The order matters:
//
//   - the SSE hub goes first, because an open event stream never goes idle on
//     its own. Draining with one still attached blocks until the deadline
//     expires on every deploy.
//   - the federation client wait is bounded, so a peer that stalls a request
//     cannot hold the process past the deadline already spent draining.
//
// The context is a parameter rather than a field, and the sequence is a
// separate function so it can be exercised in a test with a real server and a
// real stream.
func shutdown(deps shutdownDeps, ctx context.Context) {
	slog.Info("shutting down server")

	deps.limiters.closeAll()

	// Closing each connection channel makes runSSE return immediately.
	deps.hub.Close()

	drainCtx, cancel := context.WithTimeout(ctx, deps.budget)
	defer cancel()

	// Stop accepting connections and drain in-flight handlers first so no
	// new federated requests can be queued while we wait for the
	// background federation requests to finish below.
	drainErr := deps.server.Shutdown(drainCtx)

	// The background workers touch the database, so they have to be stopped
	// before the store is closed. The wait is bounded by the drain budget.
	if deps.stopWorkers != nil {
		deps.stopWorkers()
	}

	workersDone := make(chan struct{})

	go func() {
		if deps.workers != nil {
			deps.workers.Wait()
		}

		close(workersDone)
	}()

	workersErr := waitFor(workersDone, drainCtx)

	deps.fedManager.Close()

	waitErr := deps.fedClient.CloseWaitContext(drainCtx)

	deps.store.Close()

	if drainErr != nil {
		slog.Error("server forced to shutdown with requests still in flight", "err", drainErr)
	}

	if workersErr != nil {
		slog.Warn("background workers still running at shutdown", "err", workersErr)
	}

	if waitErr != nil {
		slog.Warn("federated requests still running at shutdown", "err", waitErr)
	}

	slog.Info("server stopped")
}

// waitFor waits for a channel to be closed, or for the context to be done.
func waitFor(done <-chan struct{}, ctx context.Context) error {
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func resolveStaticDir(staticDir string) string {
	if staticDir == "" {
		return ""
	}

	absDir, err := filepath.Abs(staticDir)
	if err != nil {
		slog.Warn("invalid static_dir, skipping static file serving", "path", staticDir, "err", err)

		return ""
	}

	if info, statErr := os.Stat(absDir); statErr != nil || !info.IsDir() {
		slog.Warn("static_dir not found, skipping static file serving", "path", absDir)

		return ""
	}

	slog.Info("serving static files", "dir", absDir)

	return absDir
}

func spaFallbackMiddleware(staticDir string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if staticDir == "" || r.Method != http.MethodGet {
				next.ServeHTTP(w, r)

				return
			}

			path := r.URL.Path
			// Backend-owned paths must reach their handlers; the SPA shell is
			// only for client-side routes. This list mirrors the routes owned
			// by the Huma transport (/api, /docs, /openapi) and the infra mux
			// (health probes, federation well-known).
			isBackend := strings.HasPrefix(path, "/api/") ||
				strings.HasPrefix(path, "/.well-known/") ||
				strings.HasPrefix(path, "/docs") ||
				strings.HasPrefix(path, "/openapi") ||
				path == "/healthz" ||
				path == "/readyz"

			if isBackend {
				next.ServeHTTP(w, r)

				return
			}

			// filepath.Clean on a rooted path collapses every ".." against the
			// virtual root, so the result can never escape staticDir and Join
			// keeps it contained.
			fullPath := filepath.Join(staticDir, filepath.Clean("/"+path))
			if info, err := os.Stat(fullPath); err == nil && !info.IsDir() { //nolint:gosec // path is cleaned against "/" above, so it stays inside staticDir
				http.ServeFile(w, r, fullPath) //nolint:gosec // same containment argument as the os.Stat call above

				return
			}

			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
		})
	}
}
