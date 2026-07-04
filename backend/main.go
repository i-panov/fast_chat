package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
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
	"fast_chat/handler"
	"fast_chat/store"
)

type rateLimiter struct {
	mu         sync.Mutex
	entries    map[string][]time.Time
	limit      int
	window     time.Duration
	maxEntries int
	closeCh    chan struct{}
}

func newRateLimiter(limit int, window time.Duration, maxEntries int) *rateLimiter {
	rl := &rateLimiter{
		entries:    make(map[string][]time.Time),
		limit:      limit,
		window:     window,
		maxEntries: maxEntries,
		closeCh:    make(chan struct{}),
	}

	go rl.clean()

	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if len(rl.entries) >= rl.maxEntries {
		now := time.Now()

		cutoff := now.Add(-rl.window)
		for ip, timestamps := range rl.entries {
			var valid []time.Time

			for _, t := range timestamps {
				if t.After(cutoff) {
					valid = append(valid, t)
				}
			}

			if len(valid) == 0 {
				delete(rl.entries, ip)
			} else {
				rl.entries[ip] = valid
			}
		}
	}

	now := time.Now()
	cutoff := now.Add(-rl.window)

	timestamps := rl.entries[ip]

	var valid []time.Time

	for _, t := range timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= rl.limit {
		rl.entries[ip] = valid

		return false
	}

	rl.entries[ip] = append(valid, now)

	return true
}

func (rl *rateLimiter) clean() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			now := time.Now()
			cutoff := now.Add(-rl.window)

			for ip, timestamps := range rl.entries {
				var valid []time.Time

				for _, t := range timestamps {
					if t.After(cutoff) {
						valid = append(valid, t)
					}
				}

				if len(valid) == 0 {
					delete(rl.entries, ip)
				} else {
					rl.entries[ip] = valid
				}
			}

			rl.mu.Unlock()

		case <-rl.closeCh:
			return
		}
	}
}

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

func rateLimitMiddleware(rl *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if !rl.allow(ip) {
				http.Error(w, "too many requests", http.StatusTooManyRequests)

				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func maxBody(limit int64, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next(w, r)
	}
}

func main() {
	configPath := flag.String("config", "", "path to config file (required)")

	flag.Parse()

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
		log.Printf("FATAL: Failed to create data directory: %v", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.Uploads.Dir, 0o750); err != nil {
		log.Printf("FATAL: Failed to create upload directory: %v", err)
		os.Exit(1)
	}

	db, err := store.InitDB(cfg.Database.Path)
	if err != nil {
		log.Printf("FATAL: Failed to initialize database: %v", err)
		os.Exit(1)
	}

	fedKey, err := federation.LoadOrGenerateKeys(cfg.Federation.KeyPath)
	if err != nil {
		log.Printf("FATAL: Failed to load federation keys: %v", err)
		os.Exit(1)
	}

	fedManager := federation.New(fedKey, cfg.Server.Domain, cfg.Federation.Scheme, cfg.Federation.Timeout)

	st := store.New(db)
	st.Codes().StartCleanup(context.Background(), time.Minute)
	handlerInstance := handler.New(st, cfg, fedManager)

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/config", handlerInstance.GetConfig)

	// Auth routes (no auth middleware, rate limited)
	sendCodeRL := newRateLimiter(cfg.RateLimits.SendCode.Limit, cfg.RateLimits.SendCode.Window, 10000)
	verifyCodeRL := newRateLimiter(cfg.RateLimits.VerifyCode.Limit, cfg.RateLimits.VerifyCode.Window, 10000)
	registerRL := newRateLimiter(cfg.RateLimits.Register.Limit, cfg.RateLimits.Register.Window, 10000)

	mux.Handle("POST /api/auth/send-code", rateLimitMiddleware(sendCodeRL)(maxBody(1<<20, handlerInstance.SendCode)))
	mux.Handle("POST /api/auth/verify-code", rateLimitMiddleware(verifyCodeRL)(maxBody(1<<20, handlerInstance.VerifyCode)))
	mux.Handle("POST /api/auth/complete-registration", rateLimitMiddleware(registerRL)(maxBody(1<<20, handlerInstance.CompleteRegistration)))

	sseAuthRL := newRateLimiter(30, time.Minute, 10000)
	mux.Handle("POST /api/auth/sse-auth", rateLimitMiddleware(sseAuthRL)(maxBody(1<<20, handlerInstance.SSEAuth)))
	mux.HandleFunc("POST /api/auth/refresh-token", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.RefreshToken)))

	// SSE endpoint (no auth middleware — auth happens via SSEAuth)
	mux.HandleFunc("GET /api/events", handlerInstance.SSE)

	mux.HandleFunc("GET /api/users/search", handlerInstance.AuthMiddleware(handlerInstance.SearchUsers))
	mux.HandleFunc("GET /api/chats", handlerInstance.AuthMiddleware(handlerInstance.GetChats))
	mux.HandleFunc("GET /api/sync", handlerInstance.AuthMiddleware(handlerInstance.Sync))
	mux.HandleFunc("POST /api/chats", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.CreateChat)))
	mux.HandleFunc("GET /api/chats/{id}", handlerInstance.AuthMiddleware(handlerInstance.GetChat))
	mux.HandleFunc("PATCH /api/chats/{id}", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.UpdateChat)))
	mux.HandleFunc("DELETE /api/chats/{id}", handlerInstance.AuthMiddleware(handlerInstance.DeleteChat))
	mux.HandleFunc("POST /api/chats/{id}/members", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.AddChatMember)))
	mux.HandleFunc("DELETE /api/chats/{id}/members/{userId}", handlerInstance.AuthMiddleware(handlerInstance.RemoveChatMember))
	mux.HandleFunc("POST /api/chats/{id}/avatar", handlerInstance.AuthMiddleware(handlerInstance.UpdateChatAvatar))
	mux.HandleFunc("GET /api/chats/{id}/messages", handlerInstance.AuthMiddleware(handlerInstance.GetMessages))
	mux.HandleFunc("POST /api/chats/{id}/messages", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.SendMessage)))
	mux.HandleFunc("PATCH /api/chats/{id}/messages/{messageId}", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.EditMessage)))
	mux.HandleFunc("DELETE /api/chats/{id}/messages/{messageId}", handlerInstance.AuthMiddleware(handlerInstance.DeleteMessage))
	mux.HandleFunc("POST /api/chats/{id}/messages/{messageId}/thread", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.CreateThread)))
	mux.HandleFunc("GET /api/chats/{id}/threads", handlerInstance.AuthMiddleware(handlerInstance.GetThreads))
	mux.HandleFunc("GET /api/chats/{id}/threads/{threadId}/messages", handlerInstance.AuthMiddleware(handlerInstance.GetThreadMessages))
	mux.HandleFunc("POST /api/chats/{id}/threads/{threadId}/messages", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.SendThreadMessage)))
	mux.HandleFunc("PATCH /api/chats/{id}/threads/{threadId}/messages/{messageId}", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.EditThreadMessage)))
	mux.HandleFunc("POST /api/files/upload", handlerInstance.AuthMiddleware(handlerInstance.UploadFile))
	mux.HandleFunc("GET /api/files/{fileId}", handlerInstance.AuthMiddleware(handlerInstance.ServeFile))
	mux.HandleFunc("POST /api/chats/{id}/typing", maxBody(1<<20, handlerInstance.AuthMiddleware(handlerInstance.HandleTyping)))

	// Federated endpoints (server-to-server, with federated auth)
	fedAuth := handlerInstance.FederatedAuthMiddleware
	mux.HandleFunc("GET /api/federated/users/search", fedAuth(handlerInstance.FederatedSearchUsers))
	mux.HandleFunc("POST /api/federated/chats", maxBody(1<<20, fedAuth(handlerInstance.FederatedCreateChat)))
	mux.HandleFunc("POST /api/federated/chats/{id}/messages", maxBody(1<<20, fedAuth(handlerInstance.FederatedSendMessage)))
	mux.HandleFunc("PATCH /api/federated/chats/{id}/messages/{messageId}", maxBody(1<<20, fedAuth(handlerInstance.FederatedEditMessage)))
	mux.HandleFunc("PATCH /api/federated/chats/{id}/threads/{threadId}/messages/{messageId}", maxBody(1<<20, fedAuth(handlerInstance.FederatedEditThreadMessage)))
	mux.HandleFunc("DELETE /api/federated/chats/{id}/messages/{messageId}", fedAuth(handlerInstance.FederatedDeleteMessage))
	mux.HandleFunc("POST /api/federated/chats/{id}/typing", maxBody(1<<20, fedAuth(handlerInstance.FederatedHandleTyping)))
	mux.HandleFunc("GET /api/federated/sync", fedAuth(handlerInstance.FederatedSync))

	// Well-known endpoint (no auth, public key for federation)
	mux.HandleFunc("GET /.well-known/fast-chat", fedManager.WellKnownHandler)

	// Static file serving for production frontend build
	absStaticDir := resolveStaticDir(cfg.Server.StaticDir)

	generalRL := newRateLimiter(cfg.RateLimits.General.Limit, cfg.RateLimits.General.Window, 10000)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)

	server := &http.Server{
		Addr:              addr,
		Handler:           corsMiddleware(cfg.CORS.Origin)(rateLimitMiddleware(generalRL)(spaFallbackMiddleware(absStaticDir)(mux))),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("server starting", "addr", addr)

		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
		}
	}()

	<-quit
	slog.Info("shutting down server")

	close(generalRL.closeCh)
	close(sendCodeRL.closeCh)
	close(verifyCodeRL.closeCh)
	close(registerRL.closeCh)
	close(sseAuthRL.closeCh)

	fedManager.Close()

	handlerInstance.Close()

	st.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("server forced to shutdown", "err", err)
	}

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
