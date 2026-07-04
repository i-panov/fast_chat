package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
)

const (
	defaultMessagesLimit = 30
	maxMessagesLimit     = 100
	maxMessageLen        = 10000
	maxMessageFiles      = 10
)

func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat := h.requireChatMember(w, r, chatID, user.ID)
	if chat == nil {
		return
	}

	limit := defaultMessagesLimit

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= maxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetMessagesPaginated(r.Context(), chatID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	if len(messages) > 0 {
		ids := make([]string, len(messages))
		for i, m := range messages {
			ids[i] = m.ID
		}

		filesByMsg, err := h.store.GetMessageFilesBatch(r.Context(), ids)
		if err == nil {
			for i := range messages {
				messages[i].Files = filesByMsg[messages[i].ID]
			}
		}
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

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
		ID        string          `json:"id"`
		Text      string          `json:"text"`
		ReplyToID string          `json:"replyToId"`
		FileIDs   []string        `json:"fileIDs,omitempty"`
		Location  *model.Location `json:"location,omitempty"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 && req.Location == nil {
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)
		return
	}

	if utf8.RuneCountInString(req.Text) > maxMessageLen {
		writeError(w, http.StatusBadRequest, "message too long")
		return
	}

	if len(req.FileIDs) > maxMessageFiles {
		writeError(w, http.StatusBadRequest, "too many files")
		return
	}

	if req.Location != nil {
		if !validCoords(req.Location.Lat, req.Location.Lng) {
			writeError(w, http.StatusBadRequest, "invalid coordinates")
			return
		}
	}

	msg, err := h.store.AddMessage(r.Context(), chatID, threadID, user.ID, user.Nick, req.Text, req.ID, req.ReplyToID, req.Location)
	if err != nil {
		slog.Error("failed to send message", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if len(req.FileIDs) > 0 {
		if err := h.store.AddMessageFiles(r.Context(), msg.ID, req.FileIDs); err != nil {
			logger.Info("failed to link files to message", "err", err)
		}

		files, _ := h.store.GetMessageFiles(r.Context(), msg.ID) //nolint:errcheck
		msg.Files = files
	}

	if threadID != "" {
		eventData := map[string]any{
			"threadId": threadID,
			"message":  msg,
		}

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "thread_message_new", Data: eventData})

			if memberID != user.ID {
				h.sendPushForMessage(r.Context(), chatID, msg, threadID, memberID)
			}
		}
	} else {
		h.sendFedPost(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages", map[string]any{
			"id":        msg.ID,
			"fromId":    msg.FromID,
			"fromNick":  msg.FromNick,
			"text":      msg.Text,
			"replyToId": req.ReplyToID,
			"location":  req.Location,
		})

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "new_message", Data: msg})

			if memberID != user.ID {
				h.sendPushForMessage(r.Context(), chatID, msg, "", memberID)
			}
		}
	}

	WriteJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")
	threadID := r.PathValue("threadId")

	var chat *model.Chat
	lookupID := chatID

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

		lookupID = threadID
	} else {
		chat = h.requireChatMember(w, r, chatID, user.ID)
		if chat == nil {
			return
		}
	}

	msg, err := h.store.GetMessage(r.Context(), lookupID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	if msg.FromID != user.ID {
		writeError(w, http.StatusForbidden, "not your message")
		return
	}

	if h.cfg.MessageEditTTL < 0 {
		writeError(w, http.StatusForbidden, "editing not allowed")
		return
	}

	if h.cfg.MessageEditTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(h.cfg.MessageEditTTL)*time.Second {
		writeError(w, http.StatusForbidden, "edit window expired")
		return
	}

	var req struct {
		Text     string          `json:"text"`
		FileIDs  []string        `json:"fileIDs,omitempty"`
		Location json.RawMessage `json:"location"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)
		return
	}

	location, clearLocation, locErr := parseLocationPatch(req.Location)
	if locErr != nil {
		writeError(w, http.StatusBadRequest, locErr.Error())
		return
	}

	req.Text = strings.TrimSpace(req.Text)

	hasLocation := location != nil

	if req.Text == "" && len(req.FileIDs) == 0 && !hasLocation && !clearLocation {
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)
		return
	}

	if utf8.RuneCountInString(req.Text) > maxMessageLen {
		writeError(w, http.StatusBadRequest, "message too long")
		return
	}

	if len(req.FileIDs) > maxMessageFiles {
		writeError(w, http.StatusBadRequest, "too many files")
		return
	}

	updated, err := h.store.EditMessage(r.Context(), chatID, threadID, messageID, user.ID, req.Text, location, clearLocation)
	if err != nil {
		slog.Error("failed to edit message", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if req.FileIDs != nil {
		if err := h.store.SetMessageFiles(r.Context(), messageID, req.FileIDs); err != nil {
			logger.Info("failed to set message files", "err", err)
		}

		files, _ := h.store.GetMessageFiles(r.Context(), messageID) //nolint:errcheck
		updated.Files = files
	}

	if threadID != "" {
		h.sendFedPatch(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/threads/"+threadID+"/messages/"+messageID, map[string]any{
			"text":     req.Text,
			"fileIDs":  req.FileIDs,
			"location": req.Location,
		})

		eventData := map[string]any{
			"threadId": threadID,
			"message":  &updated,
		}

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "thread_message_updated", Data: eventData})
		}
	} else {
		h.sendFedPatch(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID, map[string]any{
			"text":     req.Text,
			"fileIDs":  req.FileIDs,
			"location": req.Location,
		})

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, sse.Event{Event: "message_updated", Data: &updated})
		}
	}

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

	msg, err := h.store.GetMessage(r.Context(), chatID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, errKeyMsgNotFound)
		return
	}

	if msg.FromID != user.ID {
		writeError(w, http.StatusForbidden, "not your message")
		return
	}

	if h.cfg.MessageDeleteTTL < 0 {
		writeError(w, http.StatusForbidden, "deleting not allowed")
		return
	}

	if h.cfg.MessageDeleteTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(h.cfg.MessageDeleteTTL)*time.Second {
		writeError(w, http.StatusForbidden, "delete window expired")
		return
	}

	if err := h.store.DeleteMessage(r.Context(), chatID, messageID, user.ID); err != nil {
		slog.Error("failed to delete message", "err", err)
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	h.sendFedDelete(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: "message_deleted", Data: map[string]string{"chatId": chatID, "messageId": messageID}})
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
