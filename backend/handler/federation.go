package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

var errFederatedStatus = errors.New("federated request returned unexpected status")

func isValidRemoteDomain(domain string) bool {
	if domain == "localhost" || domain == "localhost." {
		return false
	}

	ip := net.ParseIP(domain)
	if ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return false
		}
	}

	return true
}

// federatedURL builds a federation URL using the configured scheme.
func (h *Handler) federatedURL(remoteServer, path string) string {
	return fmt.Sprintf("%s://%s%s", h.cfg.Federation.Scheme, remoteServer, path)
}

// remoteServerFromID extracts the server domain from a federated user ID ("nick:domain").
func remoteServerFromID(id string) string {
	if idx := strings.Index(id, ":"); idx != -1 && idx < len(id)-1 {
		domain := id[idx+1:]
		if _, err := url.Parse("//" + domain); err != nil {
			return ""
		}

		if strings.ContainsAny(domain, "/@?#") {
			return ""
		}

		if !isValidRemoteDomain(domain) {
			return ""
		}

		return domain
	}

	return ""
}

func (h *Handler) doFederatedRequest(ctx context.Context, method, urlStr string, body any) ([]byte, error) {
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

	signature, err := h.fedManager.Sign(method, parsedURL.RequestURI(), bodyBytes, timestamp)
	if err != nil {
		return nil, fmt.Errorf("federation sign: %w", err)
	}

	var lastErr error

	for attempt := range 3 {
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		req, reqErr := http.NewRequestWithContext(ctx, method, urlStr, bodyReader)
		if reqErr != nil {
			return nil, reqErr
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Federation-Server", h.cfg.Server.Domain)
		req.Header.Set("X-Federation-Signature", signature)
		req.Header.Set("X-Federation-Timestamp", strconv.FormatInt(timestamp, 10))

		resp, err := h.fedClient.Do(req)
		if err != nil {
			lastErr = err

			if attempt < 2 {
				time.Sleep(time.Duration(1<<attempt) * time.Second)
			}

			continue
		}

		if resp.StatusCode >= 400 {
			resp.Body = http.MaxBytesReader(nil, resp.Body, 10<<20)
			respBody, readErr := io.ReadAll(resp.Body)
			if err := resp.Body.Close(); err != nil {
				slog.Warn("failed to close response body", "err", err)
			}

			if readErr != nil {
				return nil, fmt.Errorf("%w: %d", errFederatedStatus, resp.StatusCode)
			}

			return nil, fmt.Errorf("%w: %d: %s", errFederatedStatus, resp.StatusCode, strings.TrimSpace(string(respBody)))
		}

		resp.Body = http.MaxBytesReader(nil, resp.Body, 10<<20)
		body, readErr := io.ReadAll(resp.Body)
		if err := resp.Body.Close(); err != nil {
			slog.Warn("failed to close response body", "err", err)
		}

		if readErr != nil {
			return nil, readErr
		}

		return body, nil
	}

	return nil, fmt.Errorf("federated request failed after retries: %w", lastErr)
}

// sendFedPost отправляет POST-запрос на удалённый сервер федерации.
// Если remoteServer пустой, ничего не делает.
//
// Отправка выполняется в фоне: федеративные запросы имеют собственные
// ретраи и таймауты, и синхронное ожидание заставило бы клиента ждать
// ответа на каждое сообщение при недоступном удалённом сервере.
func (h *Handler) sendFedPost(ctx context.Context, remoteServer, path string, body any) {
	if remoteServer == "" {
		return
	}

	h.doFedRequestBackground(ctx, remoteServer, path, http.MethodPost, body)
}

// sendFedPatch отправляет PATCH-запрос на удалённый сервер федерации.
func (h *Handler) sendFedPatch(ctx context.Context, remoteServer, path string, body any) {
	if remoteServer == "" {
		return
	}

	h.doFedRequestBackground(ctx, remoteServer, path, http.MethodPatch, body)
}

// sendFedDelete отправляет DELETE-запрос на удалённый сервер федерации.
func (h *Handler) sendFedDelete(ctx context.Context, remoteServer, path string) {
	if remoteServer == "" {
		return
	}

	h.doFedRequestBackground(ctx, remoteServer, path, http.MethodDelete, nil)
}

// doFedRequestBackground выполняет федеративный запрос в фоне с
// собственным таймаутом, не привязанным к жизненному циклу исходного
// HTTP-запроса. Значения (trace и пр.) из исходного контекста
// сохраняются через context.WithoutCancel, но отмена запроса не
// прерывает уже начатые ретраи. Семафор ограничивает число
// одновременных фоновых запросов, а recover() не даёт панике в
// горутине уронить процесс.
func (h *Handler) doFedRequestBackground(ctx context.Context, remoteServer, path, method string, body any) {
	select {
	case h.fedSem <- struct{}{}:
	default:
		logger.Warn("federation worker pool saturated, dropping request", "method", method, "path", path)
		return
	}

	h.fedWG.Add(1)

	go func() {
		defer func() {
			<-h.fedSem
			h.fedWG.Done()
			if r := recover(); r != nil {
				logger.Error("panic in federation background request", "method", method, "path", path, "panic", r)
			}
		}()

		baseCtx := context.WithoutCancel(ctx)
		ctx, cancel := context.WithTimeout(baseCtx, 30*time.Second)
		defer cancel()

		_, err := h.doFederatedRequest(ctx, method, h.federatedURL(remoteServer, path), body)
		if err != nil {
			logger.Info("federated request failed", "method", method, "path", path, "err", err)
		}
	}()
}

// authorizeFederatedSource verifies that the request is from the server
// that owns the given chat. It writes a 403 and returns false otherwise.
func authorizeFederatedSource(w http.ResponseWriter, chat *model.Chat, r *http.Request) bool {
	remoteServer := r.Header.Get("X-Federation-Server")
	if remoteServer == "" || chat.RemoteServer != remoteServer {
		writeError(w, http.StatusForbidden, errKeyNotMember)
		return false
	}

	return true
}

// userIDBelongsToServer returns true if userID is a federated ID whose
// domain suffix matches the given server domain.
func userIDBelongsToServer(userID, serverDomain string) bool {
	idx := strings.LastIndex(userID, ":")
	if idx < 0 || idx == len(userID)-1 {
		return false
	}

	return userID[idx+1:] == serverDomain
}

// federatedChatMembersValid checks that exactly one member belongs to the
// remote server and the other to the local server.
func federatedChatMembersValid(members []string, remoteServer, localServer string) bool {
	if remoteServer == "" || localServer == "" {
		return false
	}

	remoteCount := 0
	localCount := 0

	for _, m := range members {
		switch {
		case userIDBelongsToServer(m, remoteServer):
			remoteCount++
		case userIDBelongsToServer(m, localServer):
			localCount++
		default:
			return false
		}
	}

	return remoteCount == 1 && localCount == 1
}

// FederatedSearchUsers handles search requests from remote servers (no auth).
func (h *Handler) FederatedSearchUsers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")

	if utf8.RuneCountInString(strings.TrimSpace(query)) < nickMinSearchRunes {
		WriteJSON(w, http.StatusOK, map[string]any{"users": []model.PublicUser{}})
		return
	}

	users := h.store.SearchUsers(r.Context(), query, "")

	if users == nil {
		users = []model.PublicUser{}
	}

	WriteJSON(w, http.StatusOK, map[string]any{"users": users})
}

// FederatedCreateChat creates a chat on behalf of a remote server.
func (h *Handler) FederatedCreateChat(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	var req struct {
		ChatID       string   `json:"chatId"`
		Members      []string `json:"members"`
		RemoteServer string   `json:"remoteServer"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if len(req.Members) != 2 {
		writeError(w, http.StatusBadRequest, "federated chat must have exactly 2 members")
		return
	}

	headerServer := r.Header.Get("X-Federation-Server")
	if headerServer == "" || req.RemoteServer != headerServer {
		writeError(w, http.StatusForbidden, "remote server mismatch")
		return
	}

	if !federatedChatMembersValid(req.Members, headerServer, h.fedManager.ServerDomain()) {
		writeError(w, http.StatusBadRequest, "members must belong to federation endpoints")
		return
	}

	if _, ok := h.store.GetChat(r.Context(), req.ChatID); ok {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "already exists"})
		return
	}

	chat := &model.Chat{
		ID:           req.ChatID,
		Members:      req.Members,
		CreatedAt:    time.Now(),
		RemoteServer: req.RemoteServer,
	}

	if err := h.store.CreateRemoteChat(r.Context(), chat); err != nil {
		logger.Error("failed to create remote chat", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")

		return
	}

	enriched := h.enrichChat(r.Context(), chat)
	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "chat_created", Data: enriched})
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"chat": enriched})
}

// FederatedSendMessage handles incoming messages from remote servers.
func (h *Handler) FederatedSendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	var req struct {
		ID               string          `json:"id"`
		FromID           string          `json:"fromId"`
		FromNick         string          `json:"fromNick"`
		Text             string          `json:"text"`
		ReplyToID        string          `json:"replyToId"`
		Location         *model.Location `json:"location,omitempty"`
		Encrypted        bool            `json:"encrypted"`
		EncryptedPayload string          `json:"encryptedPayload"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if err := validateEncryptedPayload(req.Encrypted, req.EncryptedPayload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if !userIDBelongsToServer(req.FromID, chat.RemoteServer) {
		writeError(w, http.StatusForbidden, "fromId does not belong to remote server")
		return
	}

	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)
		return
	}

	maxLen := maxMessageLen
	if req.Encrypted {
		maxLen = encryptedMaxLen
	}

	if utf8.RuneCountInString(req.Text) > maxLen {
		writeError(w, http.StatusBadRequest, "message too long")
		return
	}

	if req.Location != nil && !validCoords(req.Location.Lat, req.Location.Lng) {
		writeError(w, http.StatusBadRequest, "invalid coordinates")
		return
	}

	msg := model.Message{
		ID:               req.ID,
		ChatID:           chatID,
		FromID:           req.FromID,
		FromNick:         req.FromNick,
		Text:             req.Text,
		Encrypted:        req.Encrypted,
		EncryptedPayload: req.EncryptedPayload,
		CreatedAt:        time.Now(),
		Location:         req.Location,
	}

	if req.ReplyToID != "" {
		if parent, err := h.store.GetMessage(r.Context(), chatID, req.ReplyToID); err == nil {
			msg.ReplyTo = &model.ReplyToInfo{
				MessageID: req.ReplyToID,
				Text:      parent.Text,
				FromNick:  parent.FromNick,
				Files:     h.store.GetMessageFilesForReply(r.Context(), parent.ID),
				Location:  parent.Location,
			}
		}
	}

	if err := h.store.AddRawMessage(r.Context(), &msg); err != nil {
		slog.Error("federated send message failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "new_message", Data: &msg})
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

// FederatedEditMessage handles incoming message edits from remote servers.
func (h *Handler) FederatedEditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")
	threadID := r.PathValue("threadId")

	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	lookupID := chatID

	if threadID != "" {
		lookupID = threadID
	}

	stored, err := h.store.GetMessage(r.Context(), lookupID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	if !userIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		writeError(w, http.StatusForbidden, "message author does not belong to remote server")
		return
	}

	if h.cfg.MessageEditTTL < 0 {
		writeError(w, http.StatusForbidden, "editing not allowed")
		return
	}

	if h.cfg.MessageEditTTL > 0 && time.Since(stored.CreatedAt) > time.Duration(h.cfg.MessageEditTTL)*time.Second {
		writeError(w, http.StatusForbidden, "edit window expired")
		return
	}

	edit, errMsg := h.parseEditPayload(r, stored.Encrypted, stored.EncryptedPayload)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	now := time.Now()

	if err := h.store.EditRawMessage(
		r.Context(), lookupID, messageID, edit.text, now,
		edit.location, edit.clearLocation, edit.encryptedPtr, edit.encryptedPayloadPtr,
	); err != nil {
		slog.Error("federated edit message failed", "err", err)
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	updated := &model.Message{
		ID:               messageID,
		ChatID:           chatID,
		FromID:           stored.FromID,
		FromNick:         stored.FromNick,
		Text:             edit.text,
		Encrypted:        edit.encrypted,
		EncryptedPayload: edit.encryptedPayload,
		CreatedAt:        stored.CreatedAt,
		EditedAt:         &now,
	}

	if edit.fileIDs != nil {
		validIDs := getValidFileIDs(r.Context(), h.store, edit.fileIDs)

		if len(validIDs) > 0 {
			if err := h.store.SetMessageFiles(r.Context(), messageID, validIDs); err != nil {
				logger.Info("federated edit: failed to set message files", "err", err)
			}

			files, _ := h.store.GetMessageFiles(r.Context(), messageID) //nolint:errcheck // best-effort: failure is not actionable
			updated.Files = files
		}
	}

	if len(edit.rawLocation) > 0 {
		if edit.clearLocation {
			updated.Location = nil
		} else {
			updated.Location = edit.location
		}
	} else if stored, gerr := h.store.GetMessage(r.Context(), lookupID, messageID); gerr == nil {
		updated.Location = stored.Location
	}

	if threadID != "" {
		eventData := map[string]any{
			"threadId": threadID,
			"message":  updated,
		}

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "thread_message_updated", Data: eventData})
		}
	} else {
		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "message_updated", Data: updated})
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{"message": updated})
}

// FederatedDeleteMessage handles incoming message deletions from remote servers.
func (h *Handler) FederatedDeleteMessage(w http.ResponseWriter, r *http.Request) {
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	stored, err := h.store.GetMessage(r.Context(), chatID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	if !userIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		writeError(w, http.StatusForbidden, "message author does not belong to remote server")
		return
	}

	if h.cfg.MessageDeleteTTL < 0 {
		writeError(w, http.StatusForbidden, "deleting not allowed")
		return
	}

	if h.cfg.MessageDeleteTTL > 0 && time.Since(stored.CreatedAt) > time.Duration(h.cfg.MessageDeleteTTL)*time.Second {
		writeError(w, http.StatusForbidden, "delete window expired")
		return
	}

	if err := h.store.DeleteRawMessage(r.Context(), chatID, messageID); err != nil {
		slog.Error("federated delete message failed", "err", err)
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "message_deleted", Data: map[string]string{"chatId": chatID, "messageId": messageID}})
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) FederatedHandleTyping(w http.ResponseWriter, r *http.Request) {
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(r.Context(), chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)
		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	var req struct {
		UserID string `json:"userId"`
		Nick   string `json:"nick,omitempty"`
		Active bool   `json:"active"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	eventName := "typing_stop"
	if req.Active {
		eventName = "typing"
	}

	payload := map[string]string{
		"chatId": chatID,
		"userId": req.UserID,
	}

	if req.Active && req.Nick != "" {
		payload["nick"] = req.Nick
	}

	event := sse.Event{Event: eventName, Data: payload}

	for _, memberID := range chat.Members {
		if memberID != req.UserID {
			h.hub.Send(memberID, event)
		}
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func getValidFileIDs(ctx context.Context, st *store.Store, fileIDs []string) []string {
	valid := make([]string, 0, len(fileIDs))
	for _, fid := range fileIDs {
		if _, err := st.GetFile(ctx, fid); err == nil {
			valid = append(valid, fid)
		}
	}

	return valid
}
