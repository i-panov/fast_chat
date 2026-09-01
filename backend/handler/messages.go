package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"fast_chat/model"
	"fast_chat/service"
)

// messageError maps a service message-domain error to an HTTP error response
// and reports whether the response was written. Non-sentinel errors are left
// to the caller for logging/status.
func messageError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, service.ErrThreadNotFound):
		writeError(w, http.StatusNotFound, errKeyThreadNotFound)
	case errors.Is(err, service.ErrMessageNotFound):
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
	case errors.Is(err, service.ErrEmptyMessage):
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)
	case errors.Is(err, service.ErrMessageTooLong):
		writeError(w, http.StatusBadRequest, "message too long")
	case errors.Is(err, service.ErrInvalidCoordinates):
		writeError(w, http.StatusBadRequest, "invalid coordinates")
	case errors.Is(err, service.ErrTooManyFiles):
		writeError(w, http.StatusBadRequest, "too many files")
	case errors.Is(err, service.ErrNotYourMessage):
		writeError(w, http.StatusForbidden, "not your message")
	case errors.Is(err, service.ErrEditingNotAllowed):
		writeError(w, http.StatusForbidden, "editing not allowed")
	case errors.Is(err, service.ErrEditWindowExpired):
		writeError(w, http.StatusForbidden, "edit window expired")
	case errors.Is(err, service.ErrDeletingNotAllowed):
		writeError(w, http.StatusForbidden, "deleting not allowed")
	case errors.Is(err, service.ErrDeleteWindowExpired):
		writeError(w, http.StatusForbidden, "delete window expired")
	case errors.Is(err, service.ErrDeleteForbidden):
		writeError(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, service.ErrThreadOnThread):
		writeError(w, http.StatusBadRequest, "cannot create thread on a thread message")
	case errors.Is(err, service.ErrThreadAlreadyExists):
		writeError(w, http.StatusConflict, "thread already exists")
	case errors.Is(err, service.ErrReadInputRequired):
		writeError(w, http.StatusBadRequest, "messageIds and chatId are required")
	case errors.Is(err, service.ErrTooManyReadIDs):
		writeError(w, http.StatusBadRequest, "too many message IDs")
	case errors.Is(err, service.ErrMissingEncryptedPayload),
		errors.Is(err, service.ErrEncryptedPayloadTooLarge),
		errors.Is(err, service.ErrInvalidEncryptedPayload),
		errors.Is(err, service.ErrUnsupportedPayloadVersion),
		errors.Is(err, service.ErrInvalidNonce),
		errors.Is(err, service.ErrMissingEnvelopes),
		errors.Is(err, service.ErrEmptyKeyID),
		errors.Is(err, service.ErrInvalidBox):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		return false
	}

	return true
}

func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	limit := service.DefaultMessagesLimit
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= service.MaxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	result, nextCursor := h.svc.GetMessages(r.Context(), chat, user.ID, limit, before, nil)
	if result != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"messages":   result,
			"nextCursor": nextCursor,
		})

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   []model.Message{},
		"nextCursor": nextCursor,
	})
}

func (h *Handler) GetMessagesWithStatuses(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	var req struct {
		Limit      int      `json:"limit"`
		Before     string   `json:"before"`
		MissingIDs []string `json:"missingIDs"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	limit := req.Limit
	if limit <= 0 || limit > service.MaxMessagesLimit {
		limit = service.DefaultMessagesLimit
	}

	result, nextCursor := h.svc.GetMessages(r.Context(), chat, user.ID, limit, req.Before, req.MissingIDs)
	if result != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"messages":   result,
			"nextCursor": nextCursor,
		})

		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   []model.Message{},
		"nextCursor": nextCursor,
	})
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")
	threadID := r.PathValue("threadId")

	var chat *model.Chat

	if threadID != "" {
		thread, ok := h.store.GetThread(r.Context(), threadID)
		if !ok {
			writeError(w, http.StatusNotFound, errKeyThreadNotFound)
			return
		}

		chat = h.requireChatMember(w, r, thread.ChatID, user.ID)
	} else {
		chat = h.requireChatMember(w, r, chatID, user.ID)
	}

	if chat == nil {
		return
	}

	var req struct {
		ID               string          `json:"id"`
		Text             string          `json:"text"`
		ReplyToID        string          `json:"replyToId"`
		FileIDs          []string        `json:"fileIDs,omitempty"`
		FileHashes       []string        `json:"fileHashes,omitempty"`
		Location         *model.Location `json:"location,omitempty"`
		Encrypted        bool            `json:"encrypted"`
		EncryptedPayload string          `json:"encryptedPayload"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	msg, err := h.svc.SendMessage(r.Context(), chat, threadID, chatID, user.ID, user.Nick, &service.SendMessageInput{
		ID:               req.ID,
		Text:             req.Text,
		ReplyToID:        req.ReplyToID,
		FileIDs:          req.FileIDs,
		FileHashes:       req.FileHashes,
		Location:         req.Location,
		Encrypted:        req.Encrypted,
		EncryptedPayload: req.EncryptedPayload,
	})
	if err != nil {
		if !messageError(w, err) {
			slog.Error("failed to send message", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	if threadID == "" {
		h.sendFedPost(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages", map[string]any{
			"id":               msg.ID,
			"fromId":           msg.FromID,
			"fromNick":         msg.FromNick,
			"text":             msg.Text,
			"replyToId":        req.ReplyToID,
			"location":         req.Location,
			"encrypted":        msg.Encrypted,
			"encryptedPayload": msg.EncryptedPayload,
		})
	}

	for _, memberID := range chat.Members {
		if memberID == user.ID {
			continue
		}
		h.svc.SendPushForMessage(r.Context(), chatID, msg, threadID, memberID)
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")
	threadID := r.PathValue("threadId")

	var chat *model.Chat

	if threadID != "" {
		thread, ok := h.store.GetThread(r.Context(), threadID)
		if !ok {
			writeError(w, http.StatusNotFound, errKeyThreadNotFound)
			return
		}

		chat = h.requireChatMember(w, r, thread.ChatID, user.ID)
		if chat == nil {
			return
		}
	} else {
		chat = h.requireChatMember(w, r, chatID, user.ID)
		if chat == nil {
			return
		}
	}

	var req service.DecodedEditRequest

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	updated, edit, err := h.svc.EditMessage(r.Context(), chatID, threadID, messageID, user.ID, &req, h.cfg.MessageEditTTL)
	if err != nil {
		if !messageError(w, err) {
			slog.Error("failed to edit message", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	if threadID != "" {
		h.sendFedPatch(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/threads/"+threadID+"/messages/"+messageID, map[string]any{
			"text":             edit.Text,
			"fileIDs":          edit.FileIDs,
			"location":         edit.RawLocation,
			"encrypted":        edit.Encrypted,
			"encryptedPayload": edit.EncryptedPayload,
		})
	} else {
		h.sendFedPatch(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID, map[string]any{
			"text":             edit.Text,
			"fileIDs":          edit.FileIDs,
			"location":         edit.RawLocation,
			"encrypted":        edit.Encrypted,
			"encryptedPayload": edit.EncryptedPayload,
		})
	}

	h.svc.BroadcastMessageUpdated(r.Context(), chat, threadID, &updated)

	WriteJSON(w, http.StatusOK, map[string]any{"message": updated})
}

func (h *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	if err := h.svc.DeleteMessage(r.Context(), chat, chatID, messageID, user.ID, h.cfg.MessageDeleteTTL); err != nil {
		if !messageError(w, err) {
			slog.Error("failed to delete message", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	h.sendFedDelete(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

	WriteJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *Handler) MarkMessagesRead(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

	user := getUser(r)

	var req struct {
		MessageIDs []string `json:"messageIDs"`
		ChatID     string   `json:"chatId"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	if len(req.MessageIDs) == 0 || req.ChatID == "" {
		writeError(w, http.StatusBadRequest, "messageIds and chatId are required")
		return
	}

	if len(req.MessageIDs) > 100 {
		writeError(w, http.StatusBadRequest, "too many message IDs")
		return
	}

	chat := h.requireChatMember(w, r, req.ChatID, user.ID)
	if chat == nil {
		return
	}

	if err := h.svc.MarkMessagesRead(r.Context(), req.ChatID, user.ID, req.MessageIDs); err != nil {
		if !messageError(w, err) {
			slog.Error("failed to mark messages as read", "err", err)
			writeError(w, http.StatusInternalServerError, "internal error")
		}

		return
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
