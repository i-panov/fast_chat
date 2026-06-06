// Package main starts the Fast Chat server.
package main

import (
	"context"
	"errors"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
	"fast_chat/handler"
	"fast_chat/store"
)

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string][]time.Time
	limit   int
	window  time.Duration
	closeCh chan struct{}
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		entries: make(map[string][]time.Time),
		limit:   limit,
		window:  window,
		closeCh: make(chan struct{}),
	}

	go rl.clean()

	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

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

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg := config.Load()

	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o750); err != nil {
		log.Printf("FATAL: Failed to create data directory: %v", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.UploadDir, 0o750); err != nil {
		log.Printf("FATAL: Failed to create upload directory: %v", err)
		os.Exit(1)
	}

	db, err := store.InitDB(cfg.DBPath)
	if err != nil {
		log.Printf("FATAL: Failed to initialize database: %v", err)
		os.Exit(1)
	}

	fedKey, err := federation.LoadOrGenerateKeys(cfg.FederationKeyPath)
	if err != nil {
		log.Printf("FATAL: Failed to load federation keys: %v", err)
		os.Exit(1)
	}

	fedManager := federation.New(fedKey, cfg.ServerDomain, cfg.FederationScheme, cfg.FederationTimeout)

	s := store.New(db) //nolint:varnamelen // st used across startup/shutdown
	handlerInstance := handler.New(s, cfg, fedManager)

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/config", handlerInstance.GetConfig)

	// Stricter rate limit for /api/register to prevent account farming.
	registerRL := newRateLimiter(5, 10*time.Minute)
	mux.Handle("POST /api/register", rateLimitMiddleware(registerRL)(http.HandlerFunc(handlerInstance.Register)))
	mux.HandleFunc("GET /api/events", handlerInstance.SSE)
	mux.HandleFunc("GET /api/users/search", handlerInstance.AuthMiddleware(handlerInstance.SearchUsers))
	mux.HandleFunc("GET /api/chats", handlerInstance.AuthMiddleware(handlerInstance.GetChats))
	mux.HandleFunc("POST /api/chats", handlerInstance.AuthMiddleware(handlerInstance.CreateChat))
	mux.HandleFunc("GET /api/chats/{id}", handlerInstance.AuthMiddleware(handlerInstance.GetChat))
	mux.HandleFunc("PATCH /api/chats/{id}", handlerInstance.AuthMiddleware(handlerInstance.UpdateChat))
	mux.HandleFunc("DELETE /api/chats/{id}", handlerInstance.AuthMiddleware(handlerInstance.DeleteChat))
	mux.HandleFunc("POST /api/chats/{id}/members", handlerInstance.AuthMiddleware(handlerInstance.AddChatMember))
	mux.HandleFunc("DELETE /api/chats/{id}/members/{userId}", handlerInstance.AuthMiddleware(handlerInstance.RemoveChatMember))
	mux.HandleFunc("POST /api/chats/{id}/avatar", handlerInstance.AuthMiddleware(handlerInstance.UpdateChatAvatar))
	mux.HandleFunc("GET /api/chats/{id}/messages", handlerInstance.AuthMiddleware(handlerInstance.GetMessages))
	mux.HandleFunc("POST /api/chats/{id}/messages", handlerInstance.AuthMiddleware(handlerInstance.SendMessage))
	mux.HandleFunc("PATCH /api/chats/{id}/messages/{messageId}", handlerInstance.AuthMiddleware(handlerInstance.EditMessage))
	mux.HandleFunc("DELETE /api/chats/{id}/messages/{messageId}", handlerInstance.AuthMiddleware(handlerInstance.DeleteMessage))
	mux.HandleFunc("POST /api/chats/{id}/messages/{messageId}/thread", handlerInstance.AuthMiddleware(handlerInstance.CreateThread))
	mux.HandleFunc("GET /api/chats/{id}/threads", handlerInstance.AuthMiddleware(handlerInstance.GetThreads))
	mux.HandleFunc("GET /api/chats/{id}/threads/{threadId}/messages", handlerInstance.AuthMiddleware(handlerInstance.GetThreadMessages))
	mux.HandleFunc("POST /api/chats/{id}/threads/{threadId}/messages", handlerInstance.AuthMiddleware(handlerInstance.SendThreadMessage))
	mux.HandleFunc("PATCH /api/chats/{id}/threads/{threadId}/messages/{messageId}", handlerInstance.AuthMiddleware(handlerInstance.EditThreadMessage))
	mux.HandleFunc("POST /api/files/upload", handlerInstance.AuthMiddleware(handlerInstance.UploadFile))
	mux.HandleFunc("GET /api/files/{fileId}", handlerInstance.AuthMiddleware(handlerInstance.ServeFile))
	mux.HandleFunc("POST /api/chats/{id}/typing", handlerInstance.AuthMiddleware(handlerInstance.HandleTyping))

	// Federated endpoints (server-to-server, with federated auth)
	fedAuth := handlerInstance.FederatedAuthMiddleware
	mux.HandleFunc("GET /api/federated/users/search", fedAuth(handlerInstance.FederatedSearchUsers))
	mux.HandleFunc("POST /api/federated/chats", fedAuth(handlerInstance.FederatedCreateChat))
	mux.HandleFunc("POST /api/federated/chats/{id}/messages", fedAuth(handlerInstance.FederatedSendMessage))
	mux.HandleFunc("PATCH /api/federated/chats/{id}/messages/{messageId}", fedAuth(handlerInstance.FederatedEditMessage))
	mux.HandleFunc("PATCH /api/federated/chats/{id}/threads/{threadId}/messages/{messageId}", fedAuth(handlerInstance.FederatedEditThreadMessage))
	mux.HandleFunc("DELETE /api/federated/chats/{id}/messages/{messageId}", fedAuth(handlerInstance.FederatedDeleteMessage))
	mux.HandleFunc("POST /api/federated/chats/{id}/typing", fedAuth(handlerInstance.FederatedHandleTyping))

	// Well-known endpoint (no auth, public key for federation)
	mux.HandleFunc("GET /.well-known/fast-chat", fedManager.WellKnownHandler)

	rl := newRateLimiter(100, 1*time.Minute)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	addr := ":" + port

	server := &http.Server{
		Addr:              addr,
		Handler:           corsMiddleware(cfg.CORSOrigin)(rateLimitMiddleware(rl)(mux)),
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

	close(rl.closeCh)
	close(registerRL.closeCh)

	fedManager.Close()

	handlerInstance.Close()

	s.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("server forced to shutdown", "err", err)
	}

	slog.Info("server stopped")
}
