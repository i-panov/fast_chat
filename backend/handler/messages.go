package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fast_chat/model"
)

const (
	defaultMessagesLimit = 30
	maxMessagesLimit     = 100
)

func (h *Handler) GetMessages(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)

		return
	}

	limit := defaultMessagesLimit

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= maxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetMessagesPaginated(chatID, limit, before)
	if messages == nil {
		messages = []model.Message{}
	}

	if len(messages) > 0 {
		ids := make([]string, len(messages))
		for i, m := range messages {
			ids[i] = m.ID
		}

		filesByMsg, err := h.store.GetMessageFilesBatch(ids)
		if err == nil {
			for i := range messages {
				messages[i].Files = filesByMsg[messages[i].ID]
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"messages":   messages,
		"nextCursor": nextCursor,
	})
}

func (h *Handler) SendMessage(w http.ResponseWriter, r *http.Request) { //nolint:gocyclo
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)

		return
	}

	var req struct {
		ID        string          `json:"id"`
		Text      string          `json:"text"`
		ReplyToID string          `json:"replyToId"`
		FileIDs   []string        `json:"fileIDs,omitempty"`
		Location  *model.Location `json:"location,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errKeyInvalidBody)

		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 && req.Location == nil {
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)

		return
	}

	if req.Location != nil {
		if !validCoords(req.Location.Lat, req.Location.Lng) {
			writeError(w, http.StatusBadRequest, "invalid coordinates")

			return
		}
	}

	msg, err := h.store.AddMessage(chatID, user.ID, user.Nick, req.Text, req.ID, req.ReplyToID, req.Location)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())

		return
	}

	if len(req.FileIDs) > 0 {
		if err := h.store.AddMessageFiles(msg.ID, req.FileIDs); err != nil {
			logger.Info("failed to link files to message", "err", err)
		}

		files, _ := h.store.GetMessageFiles(msg.ID) //nolint:errcheck
		msg.Files = files
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages")

		fedBody := map[string]any{
			"id":       msg.ID,
			"fromId":   msg.FromID,
			"fromNick": msg.FromNick,
			"text":     msg.Text,
		}
		if req.ReplyToID != "" {
			fedBody["replyToId"] = req.ReplyToID
		}

		if req.Location != nil {
			fedBody["location"] = req.Location
		}

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPost, fedURL, fedBody)
		if fedErr != nil {
			logger.Info("federated send message failed", "err", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "new_message", Data: msg})
	}

	writeJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) { //nolint:gocognit,gocyclo
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)

		return
	}

	msg, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, "message not found")

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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

	updated, err := h.store.EditMessage(chatID, messageID, user.ID, req.Text, location, clearLocation)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())

		return
	}

	if req.FileIDs != nil {
		if err := h.store.SetMessageFiles(messageID, req.FileIDs); err != nil {
			logger.Info("failed to set message files", "err", err)
		}

		files, _ := h.store.GetMessageFiles(messageID) //nolint:errcheck
		updated.Files = files
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

		fedBody := map[string]any{
			"text": req.Text,
		}

		if req.FileIDs != nil {
			fedBody["fileIDs"] = req.FileIDs
		}

		if len(req.Location) > 0 {
			fedBody["location"] = req.Location
		}

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodPatch, fedURL, fedBody)
		if fedErr != nil {
			logger.Info("federated edit message failed", "err", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_updated", Data: &updated})
	}

	writeJSON(w, http.StatusOK, map[string]any{"message": updated})
}

func (h *Handler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)
	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeError(w, http.StatusNotFound, errKeyChatNotFound)

		return
	}

	if !isMember(chat, user.ID) {
		writeError(w, http.StatusForbidden, errKeyNotMember)

		return
	}

	msg, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeError(w, http.StatusNotFound, "message not found")

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

	if err := h.store.DeleteMessage(chatID, messageID, user.ID); err != nil {
		writeError(w, http.StatusForbidden, err.Error())

		return
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+chatID+"/messages/"+messageID)

		_, fedErr := h.doFederatedRequest(r.Context(), http.MethodDelete, fedURL, nil)
		if fedErr != nil {
			logger.Info("federated delete message failed", "err", fedErr)
		}
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "message_deleted", Data: map[string]string{"chatId": chatID, "messageId": messageID}})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
