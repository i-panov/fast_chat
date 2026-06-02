// Package handler provides HTTP handlers and SSE infrastructure for the chat API.
package handler

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"fast_chat/config"
	"fast_chat/federation"
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
	errKeyFileTooLarge = "file too large"

	sseHeartbeatInterval = 30 * time.Second
	maxUploadSize        = 50 << 20 // 50 MB
)

type SSEEvent struct {
	Event string
	Data  interface{}
}

type SSEHub struct {
	mu         sync.RWMutex
	clients    map[string][]chan SSEEvent
	lastTyping sync.Map // key "chatID:userID" → time.Time
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
	store      *store.Store
	hub        *SSEHub
	cfg        *config.Config
	fedManager *federation.Manager
	fedClient  *http.Client
}

func New(s *store.Store, cfg *config.Config, fm *federation.Manager) *Handler {
	return &Handler{
		store:      s,
		hub:        NewSSEHub(),
		cfg:        cfg,
		fedManager: fm,
		fedClient:  &http.Client{Timeout: time.Duration(cfg.FederationTimeout) * time.Second},
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

// federatedURL builds a federation URL using the configured scheme.
func (h *Handler) federatedURL(remoteServer, path string) string {
	return fmt.Sprintf("%s://%s%s", h.cfg.FederationScheme, remoteServer, path)
}

// remoteServerFromID extracts the server domain from a federated user ID ("nick:domain").
func remoteServerFromID(id string) string {
	if idx := strings.Index(id, ":"); idx != -1 && idx < len(id)-1 {
		return id[idx+1:]
	}

	return ""
}

func (h *Handler) doFederatedRequest(ctx context.Context, method, urlStr string, body interface{}) ([]byte, error) {
	var bodyBytes []byte

	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}

		bodyBytes = data
	}

	parsedURL, err := url.Parse(urlStr)
	if err != nil {
		return nil, fmt.Errorf("invalid federated URL: %w", err)
	}

	timestamp := time.Now().Unix()
	signature := h.fedManager.Sign(method, parsedURL.RequestURI(), bodyBytes, timestamp)

	var bodyReader io.Reader
	if bodyBytes != nil {
		bodyReader = bytes.NewReader(bodyBytes)
	}

	req, err := http.NewRequestWithContext(ctx, method, urlStr, bodyReader)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Federation-Server", h.cfg.ServerDomain)
	req.Header.Set("X-Federation-Signature", signature)
	req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

	resp, err := h.fedClient.Do(req)
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

func (h *Handler) FederatedAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverDomain := r.Header.Get("X-Federation-Server")
		signature := r.Header.Get("X-Federation-Signature")
		timestampStr := r.Header.Get("X-Federation-Timestamp")

		if serverDomain == "" || signature == "" || timestampStr == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "missing federation headers"})

			return
		}

		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "invalid timestamp"})

			return
		}

		now := time.Now().Unix()
		if now-timestamp > 300 || timestamp-now > 300 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "timestamp out of bounds"})

			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to read body"})

			return
		}

		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

		if !h.fedManager.Verify(r.Context(), serverDomain, signature, r.Method, r.URL.RequestURI(), bodyBytes, timestamp) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{mapKeyError: "invalid signature"})

			return
		}

		next(w, r)
	}
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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

func (h *Handler) searchFederated(w http.ResponseWriter, r *http.Request, remoteNick, remoteDomain string) {
	if remoteNick == "" || remoteDomain == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "invalid search query"})

		return
	}

	if remoteDomain == h.cfg.ServerDomain {
		users := h.store.SearchUsers(remoteNick, getUser(r).ID)
		if users == nil {
			users = []model.User{}
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})

		return
	}

	remoteURL := h.federatedURL(remoteDomain, "/api/federated/users/search?q="+url.QueryEscape(remoteNick))

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
}

func (h *Handler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	query := r.URL.Query().Get("q")

	if idx := strings.Index(query, ":"); idx != -1 {
		h.searchFederated(w, r, query[:idx], query[idx+1:])

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
	defer r.Body.Close() //nolint:errcheck

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
	if remoteServer == h.cfg.ServerDomain {
		remoteServer = ""
	}

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

		fedURL := h.federatedURL(remoteServer, "/api/federated/chats")

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
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetMessagesPaginated(chatID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	for i := range messages {
		files, _ := h.store.GetMessageFiles(messages[i].ID) //nolint:errcheck
		messages[i].Files = files
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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
		ID        string   `json:"id"`
		Text      string   `json:"text"`
		ReplyToID string   `json:"replyToId"`
		FileIDs   []string `json:"fileIDs,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyEmptyMessage})

		return
	}

	msg, err := h.store.AddMessage(chatID, user.ID, user.Nick, req.Text, req.ID, req.ReplyToID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	if len(req.FileIDs) > 0 {
		if err := h.store.AddMessageFiles(msg.ID, req.FileIDs); err != nil {
			log.Printf("failed to link files to message: %v", err)
		}

		files, _ := h.store.GetMessageFiles(msg.ID) //nolint:errcheck
		msg.Files = files
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages")

		fedBody := map[string]interface{}{
			"id":       msg.ID,
			"fromId":   msg.FromID,
			"fromNick": msg.FromNick,
			"text":     msg.Text,
		}
		if req.ReplyToID != "" {
			fedBody["replyToId"] = req.ReplyToID
		}

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, fedBody)
		if fedErr != nil {
			log.Printf("federated send message failed: %v", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "new_message", Data: msg})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

const typingThrottleInterval = 2 * time.Second

func (h *Handler) HandleTyping(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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
		Active bool `json:"active"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	if !req.Active {
		event := SSEEvent{Event: "typing_stop", Data: map[string]string{
			"chatId": chatID,
			"userId": user.ID,
		}}

		for _, memberID := range chat.Members {
			if memberID != user.ID {
				h.hub.Send(memberID, event)
			}
		}

		if chat.RemoteServer != "" {
			fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/typing")

			_, _ = h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, map[string]interface{}{ //nolint:errcheck
				"userId": user.ID,
				"active": false,
			})
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

		return
	}

	key := chatID + ":" + user.ID
	if last, ok := h.hub.lastTyping.Load(key); ok {
		if time.Since(last.(time.Time)) < typingThrottleInterval { //nolint:errcheck
			writeJSON(w, http.StatusOK, map[string]string{"status": "throttled"})

			return
		}
	}

	h.hub.lastTyping.Store(key, time.Now())

	event := SSEEvent{Event: "typing", Data: map[string]string{
		"chatId": chatID,
		"userId": user.ID,
		"nick":   user.Nick,
	}}

	for _, memberID := range chat.Members {
		if memberID != user.ID {
			h.hub.Send(memberID, event)
		}
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/typing")

		_, _ = h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, map[string]interface{}{ //nolint:errcheck
			"userId": user.ID,
			"nick":   user.Nick,
			"active": true,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil { //nolint:gosec // limited by MaxBytesReader above
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{mapKeyError: errKeyFileTooLarge})

		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "missing file"})

		return
	}

	defer file.Close() //nolint:errcheck

	tempFile, err := os.CreateTemp("", "upload-*")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to process file"})

		return
	}

	tempPath := tempFile.Name()

	defer os.Remove(tempPath) //nolint:errcheck

	hasher := sha256.New()
	multiWriter := io.MultiWriter(tempFile, hasher)

	size, err := io.Copy(multiWriter, file)
	if err != nil {
		tempFile.Close() //nolint:errcheck,gosec
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to read file"})

		return
	}

	tempFile.Close() //nolint:errcheck,gosec

	hash := hex.EncodeToString(hasher.Sum(nil))

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	existing, ok := h.store.FindFileByHash(hash)
	if ok {
		writeJSON(w, http.StatusOK, map[string]interface{}{"file": existing.ToFileInfo()})

		return
	}

	dateDir := time.Now().Format("20060102")
	ext := filepath.Ext(header.Filename)
	storageName := generateID() + ext
	relativePath := filepath.Join(dateDir, storageName)
	fullPath := filepath.Join(h.cfg.UploadDir, relativePath)

	if err := copyFile(tempPath, fullPath); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to save file"})

		return
	}

	saved, err := h.store.SaveFile(hash, mimeType, size, header.Filename, relativePath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: "failed to save file metadata"})

		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"file": saved.ToFileInfo()})
}

func (h *Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	fileID := r.PathValue("fileId")

	fileRecord, err := h.store.GetFile(fileID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "file not found"})

		return
	}

	chatIDs, err := h.store.GetFileChats(fileID)
	if err != nil || len(chatIDs) == 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	var hasAccess bool

	for _, cid := range chatIDs {
		if chat, ok := h.store.GetChat(cid); ok && isMember(chat, user.ID) {
			hasAccess = true

			break
		}
	}

	if !hasAccess {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	fullPath := filepath.Join(h.cfg.UploadDir, fileRecord.StoragePath)
	w.Header().Set("Content-Type", fileRecord.MimeType)
	w.Header().Set("Content-Disposition", "inline; filename=\""+fileRecord.OriginalName+"\"")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, fullPath) //nolint:gosec // path is controlled, generated UUID
}

func copyFile(srcPath, dstPath string) error {
	src, err := os.Open(srcPath) //nolint:gosec // paths are controlled, generated UUID
	if err != nil {
		return err
	}
	defer src.Close() //nolint:errcheck

	if err := os.MkdirAll(filepath.Dir(dstPath), 0o750); err != nil { //nolint:gosec // paths are controlled
		return err
	}

	dst, err := os.Create(dstPath) //nolint:gosec // paths are controlled
	if err != nil {
		return err
	}
	defer dst.Close() //nolint:errcheck

	_, err = io.Copy(dst, src)

	return err
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

	if len(req.Members) != 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "federated chat must have exactly 2 members"})

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
		ID        string `json:"id"`
		FromID    string `json:"fromId"`
		FromNick  string `json:"fromNick"`
		Text      string `json:"text"`
		ReplyToID string `json:"replyToId"`
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

	if req.ReplyToID != "" {
		msgs := h.store.GetMessages(chatID)

		for idx := range msgs {
			if msgs[idx].ID == req.ReplyToID {
				msg.ReplyTo = &model.ReplyToInfo{
					MessageID: req.ReplyToID,
					Text:      msgs[idx].Text,
					FromNick:  msgs[idx].FromNick,
				}

				break
			}
		}
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

	if err := h.store.EditRawMessage(chatID, messageID, req.Text, now); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: err.Error()})

		return
	}

	updated := &model.Message{
		ID:       messageID,
		ChatID:   chatID,
		Text:     req.Text,
		EditedAt: &now,
	}

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

func (h *Handler) FederatedHandleTyping(w http.ResponseWriter, r *http.Request) {
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	remoteServer := r.Header.Get("X-Federation-Server")
	if remoteServer == "" || chat.RemoteServer != remoteServer {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	var req struct {
		UserID string `json:"userId"`
		Nick   string `json:"nick,omitempty"`
		Active bool   `json:"active"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	if req.Active {
		event := SSEEvent{Event: "typing", Data: map[string]string{
			"chatId": chatID,
			"userId": req.UserID,
			"nick":   req.Nick,
		}}

		for _, memberID := range chat.Members {
			if memberID != req.UserID {
				h.hub.Send(memberID, event)
			}
		}
	} else {
		event := SSEEvent{Event: "typing_stop", Data: map[string]string{
			"chatId": chatID,
			"userId": req.UserID,
		}}

		for _, memberID := range chat.Members {
			if memberID != req.UserID {
				h.hub.Send(memberID, event)
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPatch, fedURL, map[string]string{
			"text": req.Text,
		})
		if fedErr != nil {
			log.Printf("federated edit message failed: %v", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_updated", Data: &updated})
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
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

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

// isThreadChat checks if a chat ID belongs to a thread.
func (h *Handler) isThreadChat(chatID string) bool {
	_, isThread := h.store.GetThread(chatID)

	return isThread
}

func (h *Handler) CreateThread(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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

	if h.isThreadChat(chatID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "cannot create thread on a thread message"})

		return
	}

	if _, exists := h.store.GetThreadByParentMessage(chatID, messageID); exists {
		writeJSON(w, http.StatusConflict, map[string]string{mapKeyError: "thread already exists"})

		return
	}

	thread, err := h.store.CreateThread(chatID, messageID, msg.Text, msg.FromNick)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "thread_created", Data: thread})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"thread": thread})
}

func (h *Handler) GetThreadMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	threadID := r.PathValue("threadId")

	thread, ok := h.store.GetThread(threadID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "thread not found"})

		return
	}

	chat, ok := h.store.GetChat(thread.ChatID)
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
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetThreadMessagesPaginated(threadID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func (h *Handler) SendThreadMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	threadID := r.PathValue("threadId")

	thread, ok := h.store.GetThread(threadID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "thread not found"})

		return
	}

	chat, ok := h.store.GetChat(thread.ChatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !isMember(chat, user.ID) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

		return
	}

	var req struct {
		ID        string   `json:"id"`
		Text      string   `json:"text"`
		ReplyToID string   `json:"replyToId"`
		FileIDs   []string `json:"fileIDs,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyEmptyMessage})

		return
	}

	msg, err := h.store.AddThreadMessage(threadID, user.ID, user.Nick, req.Text, req.ID, req.ReplyToID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	if len(req.FileIDs) > 0 {
		if err := h.store.AddMessageFiles(msg.ID, req.FileIDs); err != nil {
			log.Printf("failed to link files to thread message: %v", err)
		}

		files, _ := h.store.GetMessageFiles(msg.ID) //nolint:errcheck
		msg.Files = files
	}

	eventData := map[string]interface{}{
		"threadId": threadID,
		"message":  msg,
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "thread_message_new", Data: eventData})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

func (h *Handler) GetThreads(w http.ResponseWriter, r *http.Request) {
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

	threads := h.store.GetThreadsForChat(chatID)

	writeJSON(w, http.StatusOK, map[string]interface{}{"threads": threads})
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
	w.Header().Set("Access-Control-Allow-Origin", h.cfg.CORSOrigin)

	ch := h.hub.Subscribe(user.ID)

	defer func() {
		h.hub.Unsubscribe(user.ID, ch)
		h.store.RemoveConnection(user.ID)
	}()

	_, _ = fmt.Fprintf(w, "event: connected\ndata: {\"status\":\"ok\"}\n\n") //nolint:errcheck

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

func generateID() string {
	buf := make([]byte, 16)

	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("writeJSON: failed to encode response: %v", err)
	}
}
