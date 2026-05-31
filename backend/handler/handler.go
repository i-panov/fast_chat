// Package handler provides HTTP handlers and SSE infrastructure for the chat API.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"fast_chat/config"
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

	sseHeartbeatInterval = 30 * time.Second
)

type SSEEvent struct {
	Event string
	Data  interface{}
}

type SSEHub struct {
	mu      sync.RWMutex
	clients map[string][]chan SSEEvent
}

func NewSSEHub() *SSEHub {
	return &SSEHub{
		clients: make(map[string][]chan SSEEvent),
	}
}

func (h *SSEHub) Subscribe(userID string) chan SSEEvent {
	h.mu.Lock()
	defer h.mu.Unlock()

	ch := make(chan SSEEvent, 128)
	h.clients[userID] = append(h.clients[userID], ch)

	return ch
}

func (h *SSEHub) Unsubscribe(userID string, ch chan SSEEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()

	channels := h.clients[userID]
	for i, c := range channels {
		if c == ch {
			close(c)

			h.clients[userID] = append(channels[:i], channels[i+1:]...)

			break
		}
	}

	if len(h.clients[userID]) == 0 {
		delete(h.clients, userID)
	}
}

func (h *SSEHub) Send(userID string, event SSEEvent) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, ch := range h.clients[userID] {
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
	CreatedAt time.Time    `json:"createdAt"`
}

type contextKey string

const userKey contextKey = "user"

func getUser(r *http.Request) *model.User {
	user, _ := r.Context().Value(userKey).(*model.User) //nolint:errcheck // expected to be missing in unauthenticated contexts

	return user
}

type Handler struct {
	store *store.Store
	hub   *SSEHub
	cfg   *config.Config
}

func New(s *store.Store, cfg *config.Config) *Handler {
	return &Handler{
		store: s,
		hub:   NewSSEHub(),
		cfg:   cfg,
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
		} else {
			cr.Members = append(cr.Members, memberInfo{ID: member, Nick: member})
		}
	}

	return cr
}

// remoteServerFromID extracts the server domain from a federated user ID ("nick:domain").
func remoteServerFromID(id string) string {
	if idx := strings.LastIndex(id, ":"); idx != -1 && idx < len(id)-1 {
		return id[idx+1:]
	}

	return ""
}

func federatedURL(remoteServer, path string) string {
	return fmt.Sprintf("http://%s%s", remoteServer, path)
}

func (h *Handler) doFederatedRequest(ctx context.Context, method, url string, body interface{}) ([]byte, error) {
	var bodyReader io.Reader

	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}

		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, err
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("federated request failed: %w", err)
	}

	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode >= 400 {
		respBody, readErr := io.ReadAll(resp.Body)
		if readErr != nil {
			return nil, fmt.Errorf("federated request returned %d", resp.StatusCode)
		}

		return nil, fmt.Errorf("federated request returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	return io.ReadAll(resp.Body)
}

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

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // write errors are unrecoverable at this point

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

	if strings.Contains(req.Nick, ":") {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "nick must not contain ':'"})

		return
	}

	fullID := req.Nick + ":" + h.cfg.ServerDomain

	user, err := h.store.CreateUser(fullID, req.Nick)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{mapKeyError: err.Error()})

		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":  user,
		"token": user.Token,
	})
}

func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	query := r.URL.Query().Get("q")

	if idx := strings.Index(query, ":"); idx != -1 {
		remoteNick := query[:idx]
		remoteDomain := query[idx+1:]

		remoteURL := federatedURL(remoteDomain, "/api/federated/users/search?q="+url.QueryEscape(remoteNick))

		data, err := h.doFederatedRequest(r.Context(), http.MethodGet, remoteURL, nil)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{mapKeyError: err.Error()})

			return
		}

		var result struct {
			Users []model.User `json:"users"`
		}

		if err := json.Unmarshal(data, &result); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to parse remote response"})

			return
		}

		for i := range result.Users {
			result.Users[i].Nick = result.Users[i].ID
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{"users": result.Users})

		return
	}

	users := h.store.SearchUsers(query, user.ID)
	if users == nil {
		users = []model.User{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

func (h *Handler) GetChats(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chats := h.store.GetUserChats(user.ID)

	resp := make([]chatResponse, 0, len(chats))
	for _, c := range chats {
		resp = append(resp, h.enrichChat(c))
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"chats": resp})
}

func (h *Handler) CreateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // write errors are unrecoverable at this point

	user := getUser(r)

	var req struct {
		WithUserID string `json:"withUserId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	if req.WithUserID == user.ID {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "cannot chat with yourself"})

		return
	}

	remoteServer := remoteServerFromID(req.WithUserID)

	if remoteServer == "" {
		if _, ok := h.store.GetUserByID(req.WithUserID); !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "user not found"})

			return
		}
	}

	chat, err := h.store.CreateChat(user.ID, req.WithUserID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	enriched := h.enrichChat(chat)
	h.hub.Send(user.ID, SSEEvent{Event: "chat_created", Data: enriched})

	if remoteServer != "" {
		chat.RemoteServer = remoteServer

		h.hub.Send(req.WithUserID, SSEEvent{Event: "chat_created", Data: enriched})

		fedURL := federatedURL(remoteServer, "/api/federated/chats")

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, map[string]interface{}{
			"chatId":       chat.ID,
			"members":      chat.Members,
			"remoteServer": h.cfg.ServerDomain,
		})
		if fedErr != nil {
			log.Printf("federated create chat failed: %v", fedErr)
		}
	} else {
		h.hub.Send(req.WithUserID, SSEEvent{Event: "chat_created", Data: enriched})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"chat": enriched})
}

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

	limitStr := r.URL.Query().Get("limit")
	limit := 30

	if limitStr != "" {
		if n, err := parseInt(limitStr); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetMessagesPaginated(chatID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func parseInt(s string) (int, error) {
	var n int

	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}

		n = n*10 + int(c-'0')
	}

	return n, nil
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // write errors are unrecoverable at this point

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

	if chat.RemoteServer != "" {
		fedURL := federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages")

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, map[string]interface{}{
			"id":       msg.ID,
			"fromId":   msg.FromID,
			"fromNick": msg.FromNick,
			"text":     msg.Text,
		})
		if fedErr != nil {
			log.Printf("federated send message failed: %v", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "new_message", Data: msg})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

func (h *Handler) GetConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messageEditTTL":   h.cfg.MessageEditTTL,
		"messageDeleteTTL": h.cfg.MessageDeleteTTL,
	})
}

// FederatedSearchUsers handles search requests from remote servers (no auth).
func (h *Handler) FederatedSearchUsers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	users := h.store.SearchUsers(query, "")

	if users == nil {
		users = []model.User{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

// FederatedCreateChat creates a chat on behalf of a remote server.
func (h *Handler) FederatedCreateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	var req struct {
		ChatID       string   `json:"chatId"`
		Members      []string `json:"members"`
		RemoteServer string   `json:"remoteServer"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})
		return
	}

	if _, ok := h.store.GetChat(req.ChatID); ok {
		writeJSON(w, http.StatusOK, map[string]string{"status": "already exists"})
		return
	}

	chat := &model.Chat{
		ID:           req.ChatID,
		Members:      req.Members,
		CreatedAt:    time.Now(),
		RemoteServer: req.RemoteServer,
	}

	h.store.CreateRemoteChat(chat)

	enriched := h.enrichChat(chat)
	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "chat_created", Data: enriched})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"chat": enriched})
}

// FederatedSendMessage handles incoming messages from remote servers.
func (h *Handler) FederatedSendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})
		return
	}

	var req struct {
		ID       string `json:"id"`
		FromID   string `json:"fromId"`
		FromNick string `json:"fromNick"`
		Text     string `json:"text"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})
		return
	}

	msg := model.Message{
		ID:        req.ID,
		ChatID:    chatID,
		FromID:    req.FromID,
		FromNick:  req.FromNick,
		Text:      req.Text,
		CreatedAt: time.Now(),
	}

	if err := h.store.AddRawMessage(&msg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "new_message", Data: &msg})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

// FederatedEditMessage handles incoming message edits from remote servers.
func (h *Handler) FederatedEditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	var req struct {
		Text string `json:"text"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})
		return
	}

	now := time.Now()
	updated := &model.Message{
		Text:     req.Text,
		EditedAt: &now,
	}

	if err := h.store.EditRawMessage(chatID, messageID, req.Text, now); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: err.Error()})
		return
	}

	updated.ID = messageID
	updated.ChatID = chatID

	chat, ok := h.store.GetChat(chatID)
	if ok {
		for _, memberID := range chat.Members {
			h.hub.Send(memberID, SSEEvent{Event: "message_updated", Data: updated})
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"message": updated})
}

// FederatedDeleteMessage handles incoming message deletions from remote servers.
func (h *Handler) FederatedDeleteMessage(w http.ResponseWriter, r *http.Request) {
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})
		return
	}

	if err := h.store.DeleteRawMessage(chatID, messageID); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: err.Error()})
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_deleted", Data: map[string]string{"chatId": chatID, "messageId": messageID}})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // write errors are unrecoverable at this point

	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !isMember(chat, user.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	msg, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

		return
	}

	if msg.FromID != user.ID {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "not your message"})

		return
	}

	if h.cfg.MessageEditTTL < 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "editing not allowed"})

		return
	}

	if h.cfg.MessageEditTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(h.cfg.MessageEditTTL)*time.Second {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "edit window expired"})

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

	updated, err := h.store.EditMessage(chatID, messageID, user.ID, req.Text)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	if chat.RemoteServer != "" {
		fedURL := federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPatch, fedURL, map[string]string{
			"text": req.Text,
		})
		if fedErr != nil {
			log.Printf("federated edit message failed: %v", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_updated", Data: updated})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"message": updated})
}

func (h *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !isMember(chat, user.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	msg, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

		return
	}

	if msg.FromID != user.ID {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "not your message"})

		return
	}

	if h.cfg.MessageDeleteTTL < 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "deleting not allowed"})

		return
	}

	if h.cfg.MessageDeleteTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(h.cfg.MessageDeleteTTL)*time.Second {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "delete window expired"})

		return
	}

	if err := h.store.DeleteMessage(chatID, messageID, user.ID); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: err.Error()})

		return
	}

	if chat.RemoteServer != "" {
		fedURL := federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodDelete, fedURL, nil)
		if fedErr != nil {
			log.Printf("federated delete message failed: %v", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_deleted", Data: map[string]string{"chatId": chatID, "messageId": messageID}})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) SSE(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("Authorization")
	token = strings.TrimPrefix(token, "Bearer ")

	if token == "" {
		token = r.URL.Query().Get("token")
	}

	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)

		return
	}

	user, ok := h.store.GetUserByToken(token)
	if !ok {
		http.Error(w, errKeyUnauthorized, http.StatusUnauthorized)

		return
	}

	h.store.AddConnection(user.ID)

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.store.RemoveConnection(user.ID)
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)

		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := h.hub.Subscribe(user.ID)

	defer func() {
		h.hub.Unsubscribe(user.ID, ch)
		h.store.RemoveConnection(user.ID)
	}()

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck // write errors on SSE are unrecoverable

	flusher.Flush()

	ctx := r.Context()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, err := fmt.Fprintf(w, ": heartbeat\n\n")
			if err != nil {
				return
			}

			flusher.Flush()

		case evt, ok := <-ch:
			if !ok {
				return
			}

			data, marshalErr := json.Marshal(evt.Data)
			if marshalErr != nil {
				continue
			}

			_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Event, data)
			if err != nil {
				return
			}

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
