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
	"syscall"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/handler"
	"fast_chat/huma"
	"fast_chat/push"
	"fast_chat/ratelimit"
	"fast_chat/service"
	"fast_chat/sse"
	"fast_chat/store"
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

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-XSS-Protection", "0")
		next.ServeHTTP(w, r)
	})
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
		id := handler.GetRequestID(r.Context())

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
func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}

	return s.ResponseWriter.Write(b)
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

// newHumaTransport mounts the Huma v2 pilot (all /api/* domains) in front of
// the legacy stdlib mux and returns the combined handler. Requests served by
// Huma never reach the legacy mux; everything else falls through unchanged.
func newHumaTransport(
	legacyMux *http.ServeMux,
	hub *sse.Hub,
	st *store.Store,
	handlers *handler.Handler,
	cfg *config.Config,
	fedManager *federation.Manager,
	ipExtractor *ratelimit.ClientIPExtractor,
	sendCodeRL, verifyCodeRL, registerRL, sseAuthRL *ratelimit.RateLimiter,
) http.Handler {

	humaPilot := huma.NewPilot(&huma.PilotDeps{
		Hub:        hub,
		Store:      st,
		Svc:        handlers.Service(),
		Legacy:     handlers,
		Cfg:        cfg,
		FedManager: fedManager,
		PushSender: handlers,
		Version:    version,
		Commit:     commit,
		RateLimiters: &huma.RateLimiters{
			Extractor:  ipExtractor,
			SendCode:   sendCodeRL,
			VerifyCode: verifyCodeRL,
			Register:   registerRL,
			SSEAuth:    sseAuthRL,
		},
	})

	return humaPilot.FallbackHandler(legacyMux)
}

// registerRoutes wires all HTTP handlers onto the mux. The per-route rate
// limiters are created here so main() can close them on shutdown.
func registerRoutes(
	mux *http.ServeMux,
	handlers *handler.Handler,
	fedManager *federation.Manager,
) {

	// Health probes: no auth and no per-route rate limiter (used by
	// orchestrators). The global generalRL still applies at the outer layer.
	mux.HandleFunc("GET /healthz", handler.HealthzHandler)
	mux.HandleFunc("GET /readyz", handlers.ReadinessHandler)

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

	if err := os.MkdirAll(filepath.Dir(cfg.Database.Path), 0o750); err != nil {
		slog.Error("failed to create data directory", "err", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.Uploads.Dir, 0o750); err != nil {
		slog.Error("failed to create upload directory", "err", err)
		os.Exit(1)
	}

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

	fedManager := federation.New(fedKey, cfg.Server.Domain, cfg.Federation.Scheme, cfg.Federation.Timeout)

	st := store.New(db)
	st.Codes().StartCleanup(context.Background(), time.Minute)

	if err := st.AutoMigratePush(); err != nil {
		slog.Error("failed to auto-migrate push subscriptions", "err", err)
		os.Exit(1)
	}

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
	handlerInstance := handler.New(st, cfg, fedManager, pushService, hub)

	ipExtractor := ratelimit.NewClientIPExtractor(cfg.Server.TrustedProxies)

	sendCodeRL := ratelimit.New(cfg.RateLimits.SendCode.Limit, cfg.RateLimits.SendCode.Window, 10000)
	verifyCodeRL := ratelimit.New(cfg.RateLimits.VerifyCode.Limit, cfg.RateLimits.VerifyCode.Window, 10000)
	registerRL := ratelimit.New(cfg.RateLimits.Register.Limit, cfg.RateLimits.Register.Window, 10000)
	sseAuthRL := ratelimit.New(60, time.Minute, 10000)

	mux := http.NewServeMux()
	registerRoutes(mux, handlerInstance, fedManager)

	// Huma v2 transport wraps the stdlib mux: every /api/* domain is served
	// by Huma; only health probes and the well-known endpoint remain on the
	// legacy mux, reached via the fallback handler.
	humaAPI := newHumaTransport(mux, hub, st, handlerInstance, cfg, fedManager, ipExtractor,
		sendCodeRL, verifyCodeRL, registerRL, sseAuthRL)

	// Static file serving for production frontend build
	absStaticDir := resolveStaticDir(cfg.Server.StaticDir)

	generalRL := ratelimit.New(cfg.RateLimits.General.Limit, cfg.RateLimits.General.Window, 10000)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)

	server := &http.Server{
		Addr: addr,
		Handler: handler.RequestIDMiddleware(
			requestLogMiddleware(
				securityHeadersMiddleware(
					corsMiddleware(cfg.CORS.Origin)(
						rateLimitMiddleware(generalRL, ipExtractor)(
							spaFallbackMiddleware(absStaticDir)(humaAPI),
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

	runServer(server, fedManager, handlerInstance, st, generalRL, sendCodeRL, verifyCodeRL, registerRL, sseAuthRL)
}

// runServer blocks until SIGINT/SIGTERM, then drains in-flight handlers
// and background federation requests before tearing everything down.
func runServer(
	server *http.Server,
	fedManager *federation.Manager,
	handlerInstance *handler.Handler,
	st *store.Store,
	generalRL, sendCodeRL, verifyCodeRL, registerRL, sseAuthRL *ratelimit.RateLimiter,
) {

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("server starting", "addr", server.Addr)

		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
		}
	}()

	<-quit
	slog.Info("shutting down server")

	generalRL.Close()
	sendCodeRL.Close()
	verifyCodeRL.Close()
	registerRL.Close()
	sseAuthRL.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Stop accepting connections and drain in-flight handlers first so no
	// new federated requests can be queued while we wait for the
	// background federation requests to finish below.
	if err := server.Shutdown(ctx); err != nil {
		slog.Error("server forced to shutdown", "err", err)
	}

	fedManager.Close()

	handlerInstance.Close()

	st.Close()

	slog.Info("server stopped")
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
			if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/.well-known/") {
				next.ServeHTTP(w, r)

				return
			}

			fullPath := filepath.Join(staticDir, filepath.Clean("/"+path))
			if info, err := os.Stat(fullPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, fullPath)

				return
			}

			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
		})
	}
}
