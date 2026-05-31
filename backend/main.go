// Package main starts the Fast Chat server.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"fast_chat/handler"
	"fast_chat/store"
)

type rateLimiter struct {
	mu       sync.Mutex
	requests map[string]int
	limit    int
	window   time.Duration
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		requests: make(map[string]int),
		limit:    limit,
		window:   window,
	}

	go rl.clean()

	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.requests[ip]++

	return rl.requests[ip] <= rl.limit
}

func (rl *rateLimiter) clean() {
	for {
		time.Sleep(rl.window)
		rl.mu.Lock()
		rl.requests = make(map[string]int)
		rl.mu.Unlock()
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)

			return
		}

		next.ServeHTTP(w, r)
	})
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
	s := store.New()
	handlerInstance := handler.New(s)

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/register", handlerInstance.Register)
	mux.HandleFunc("GET /api/events", handlerInstance.SSE)
	mux.HandleFunc("GET /api/users/search", handlerInstance.AuthMiddleware(handlerInstance.SearchUsers))
	mux.HandleFunc("GET /api/chats", handlerInstance.AuthMiddleware(handlerInstance.GetChats))
	mux.HandleFunc("POST /api/chats", handlerInstance.AuthMiddleware(handlerInstance.CreateChat))
	mux.HandleFunc("GET /api/chats/{id}/messages", handlerInstance.AuthMiddleware(handlerInstance.GetMessages))
	mux.HandleFunc("POST /api/chats/{id}/messages", handlerInstance.AuthMiddleware(handlerInstance.SendMessage))
	mux.HandleFunc("DELETE /api/chats/{id}/messages/{messageId}", handlerInstance.AuthMiddleware(handlerInstance.DeleteMessage))

	rl := newRateLimiter(100, 1*time.Minute)

	server := &http.Server{
		Addr:              ":8080",
		Handler:           corsMiddleware(rateLimitMiddleware(rl)(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Println("Server starting on :8080")

		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("Server error: %v", err)
		}
	}()

	<-quit
	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	}

	log.Println("Server stopped")
}
