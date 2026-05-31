// Package main starts the Fast Chat server.
package main

import (
	"errors"
	"log"
	"net/http"
	"time"

	"fast_chat/handler"
	"fast_chat/store"
)

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

	server := &http.Server{
		Addr:              ":8080",
		Handler:           corsMiddleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0, // SSE needs indefinite write timeout
		IdleTimeout:       120 * time.Second,
	}

	log.Println("Server starting on :8080")

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("Server error: %v", err)

		return
	}
}
