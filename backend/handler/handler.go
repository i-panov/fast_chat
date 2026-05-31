// Package handler provides HTTP handlers and SSE infrastructure for the chat API.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"fast_chat/model"
	"fast_chat/store"
)

const (
	mapKeyError        = "error"
	errKeyUnauthorized = "unauthorized"
	errKeyInvalidBody  = "invalid body"
	errKeyChatNotFound = "chat not found"
	errKeyNotMember    = "not a member"
	errKeyEmptyMessage = "empty message"
)

// SSEEvent represents a server-sent event to be delivered to clients.
type SSEEvent struct {
	Event string
	Data  interface{}
}

// SSEHub manages client subscriptions for server-sent events.
type SSEHub struct {
	mu      sync.RWMutex
	clients map[string]chan SSEEvent
}

// NewSSEHub creates a new SSE hub.
func NewSSEHub() *SSEHub {
	return &SSEHub{
		clients: make(map[string]chan SSEEvent),
	}
}

// Subscribe registers a user for SSE events and returns a channel.
func (h *SSEHub) Subscribe(userID string) chan SSEEvent {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan SSEEvent, 128)
	h.clients[userID] = ch

	return ch
}

// Unsubscribe removes a user's SSE subscription and closes their channel.
func (h *SSEHub) Unsubscribe(userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if ch, ok := h.clients[userID]; ok {
		close(ch)
		delete(h.clients, userID)
	}
}

// Send delivers an event to a specific user if they are connected.
func (h *SSEHub) Send(userID string, event SSEEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if ch, ok := h.clients[userID]; ok {
		select {
		case ch <- event:
		default:
			log.Printf("SSE channel full for user %s, dropping event", userID) //nolint:gosec // userID is a system-generated UUID
		}
	}
}

type memberInfo struct {
	ID   string `json:"id"`
	Nick string `json:"nick"`
}

type chatResponse struct {
	ID        string       `json:"id"`
	Members   []memberInfo `json:"members"`
	CreatedAt time.Time    `json:"created_at"`
}

type contextKey string

const userKey contextKey = "user"

//nolint:unparam // always non-nil in authenticated routes
func getUser(r *http.Request) *model.User {
	user, _ := r.Context().Value(userKey).(*model.User) //nolint:errcheck // expected to be missing in unauthenticated contexts

	return user
}

// Handler groups all HTTP handler methods and their dependencies.
type Handler struct {
	store *store.Store
	hub   *SSEHub
}

// New creates a new Handler with the given store.
func New(s *store.Store) *Handler {
	return &Handler{
		store: s,
		hub:   NewSSEHub(),
	}
}

func (h *Handler) enrichChat(c *model.Chat) chatResponse {
	cr := chatResponse{
		ID:        c.ID,
		CreatedAt: c.CreatedAt,
	}

	for _, member := range c.Members {
		if u, ok := h.store.GetUserByID(member); ok {
			cr.Members = append(cr.Members, memberInfo{ID: member, Nick: u.Nick})
		}
	}

	return cr
}

// AuthMiddleware extracts the user from the Authorization header or token
// query parameter and injects it into the request context.
func (h *Handler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		token = strings.TrimPrefix(token, "Bearer ")

		if token == "" {
			token = r.URL.Query().Get("token")
		}

		user, ok := h.store.GetUserByToken(token)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: errKeyUnauthorized})

			return
		}

		ctx := context.WithValue(r.Context(), userKey, user)
		next(w, r.WithContext(ctx))
	}
}

// Register handles user registration with a unique nickname.
func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nick string `json:"nick"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	req.Nick = strings.TrimSpace(req.Nick)
	if req.Nick == "" || len(req.Nick) > 20 {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "nick must be 1-20 characters"})

		return
	}

	user, err := h.store.CreateUser(req.Nick)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{mapKeyError: err.Error()})

		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":  user,
		"token": user.Token,
	})
}

// SearchUsers searches for other users by nickname prefix.
func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	query := r.URL.Query().Get("q")

	users := h.store.SearchUsers(query, user.ID)
	if users == nil {
		users = []*model.User{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

// GetChats returns all chats for the authenticated user.
func (h *Handler) GetChats(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chats := h.store.GetUserChats(user.ID)

	resp := make([]chatResponse, 0, len(chats))
	for _, c := range chats {
		resp = append(resp, h.enrichChat(c))
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"chats": resp})
}

// CreateChat creates a new private chat with another user.
func (h *Handler) CreateChat(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	var req struct {
		WithUserID string `json:"with_user_id"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	if req.WithUserID == user.ID {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "cannot chat with yourself"})

		return
	}

	if _, ok := h.store.GetUserByID(req.WithUserID); !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "user not found"})

		return
	}

	chat, err := h.store.CreateChat(user.ID, req.WithUserID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	enriched := h.enrichChat(chat)
	h.hub.Send(user.ID, SSEEvent{Event: "chat_created", Data: enriched})
	h.hub.Send(req.WithUserID, SSEEvent{Event: "chat_created", Data: enriched})

	writeJSON(w, http.StatusCreated, map[string]interface{}{"chat": enriched})
}

// GetMessages returns the message history for a given chat.
func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !isMember(chat, user.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	messages := h.store.GetMessages(chatID)
	if messages == nil {
		messages = []model.Message{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"messages": messages})
}

// SendMessage sends a message in the specified chat.
func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !isMember(chat, user.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	var req struct {
		Text string `json:"text"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyEmptyMessage})

		return
	}

	msg, err := h.store.AddMessage(chatID, user.ID, user.Nick, req.Text)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "new_message", Data: msg})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

// SSE handles the server-sent events connection for real-time updates.
func (h *Handler) SSE(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)

		return
	}

	user, ok := h.store.GetUserByToken(token)
	if !ok {
		http.Error(w, errKeyUnauthorized, http.StatusUnauthorized)

		return
	}

	h.store.SetUserOnline(user.ID, true)

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.store.SetUserOnline(user.ID, false)
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)

		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := h.hub.Subscribe(user.ID)

	defer func() {
		h.hub.Unsubscribe(user.ID)
		h.store.SetUserOnline(user.ID, false)
	}()

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck // write errors on SSE are unrecoverable

	flusher.Flush()

	ctx := r.Context()

	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-ch:
			if !ok {
				return
			}

			data, marshalErr := json.Marshal(evt.Data)
			if marshalErr != nil {
				continue
			}

			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Event, data) //nolint:errcheck // write errors on SSE are unrecoverable

			flusher.Flush()
		}
	}
}

func isMember(chat *model.Chat, userID string) bool {
	for _, m := range chat.Members {
		if m == userID {
			return true
		}
	}

	return false
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data) //nolint:errcheck // write errors are unrecoverable at this point
}
