package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"fast_chat/model"
	"fast_chat/service"
)

var errFederatedStatus = errors.New("federated request returned unexpected status")

// federateError maps a service federation-domain error to an HTTP error
// response and reports whether the response was written. Non-sentinel errors
// are left to the caller for logging/status.
func federateError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, service.ErrFederatedChatMembers):
		writeError(w, http.StatusBadRequest, "federated chat must have exactly 2 members")
	case errors.Is(err, service.ErrFederatedMembersNotValid):
		writeError(w, http.StatusBadRequest, "members must belong to federation endpoints")
	case errors.Is(err, service.ErrFederatedFromNotRemote):
		writeError(w, http.StatusForbidden, "fromId does not belong to remote server")
	case errors.Is(err, service.ErrFederatedAuthorNotRemote):
		writeError(w, http.StatusForbidden, "message author does not belong to remote server")
	case errors.Is(err, service.ErrFederatedIDRequired):
		writeError(w, http.StatusBadRequest, "id is required")
	default:
		return messageError(w, err)
	}

	return true
}

// federatedURL builds a federation URL using the configured scheme.
func (h *Handler) federatedURL(remoteServer, path string) string {
	return fmt.Sprintf("%s://%s%s", h.cfg.Federation.Scheme, remoteServer, path)
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

		// Propagate the incoming request ID so the upstream server can correlate
		// logs with the originating request.
		if id := GetRequestID(ctx); id != "" {
			req.Header.Set(RequestIDHeader, id)
		}

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

// FederatedSearchUsers handles search requests from remote servers (no auth).
func (h *Handler) FederatedSearchUsers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")

	users := h.svc.SearchFederatedUsers(r.Context(), query)

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

	view, alreadyExists, err := h.svc.CreateFederatedChat(
		r.Context(), req.ChatID, req.Members, headerServer, h.fedManager.ServerDomain(),
	)
	if err != nil {
		if !federateError(w, err) {
			logger.Error("failed to create remote chat", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	if alreadyExists {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "already exists"})
		return
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"chat": view})
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

	maxLen := service.MaxMessageLen
	if req.Encrypted {
		maxLen = service.EncryptedMaxLen
	}

	msg, err := h.svc.SendFederatedMessage(r.Context(), chat, &service.FederatedInboundMessage{
		ID:               req.ID,
		FromID:           req.FromID,
		FromNick:         req.FromNick,
		Text:             req.Text,
		ReplyToID:        req.ReplyToID,
		Location:         req.Location,
		Encrypted:        req.Encrypted,
		EncryptedPayload: req.EncryptedPayload,
	}, maxLen)
	if err != nil {
		if !federateError(w, err) {
			slog.Error("federated send message failed", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
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

	var editReq service.DecodedEditRequest
	if err := h.decodeJSON(r, &editReq); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	updated, err := h.svc.EditFederatedMessage(
		r.Context(), chat, lookupID, messageID, threadID, &editReq, h.cfg.MessageEditTTL,
	)
	if err != nil {
		if !federateError(w, err) {
			slog.Error("federated edit message failed", "err", err)
			writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		}

		return
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

	if err := h.svc.DeleteFederatedMessage(r.Context(), chat, messageID, h.cfg.MessageDeleteTTL); err != nil {
		if !federateError(w, err) {
			slog.Error("federated delete message failed", "err", err)
			writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		}

		return
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

	h.svc.HandleFederatedTyping(r.Context(), chat, req.UserID, req.Nick, req.Active)

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
