package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fast_chat/model"
)

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

	limit := defaultMessagesLimit

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= maxMessagesLimit {
			limit = n
		}
	}

	before := r.URL.Query().Get("before")

	messages, nextCursor, _ := h.store.GetThreadMessagesPaginated(threadID, limit, before)
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
		ID        string          `json:"id"`
		Text      string          `json:"text"`
		ReplyToID string          `json:"replyToId"`
		FileIDs   []string        `json:"fileIDs,omitempty"`
		Location  *model.Location `json:"location,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 && req.Location == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyEmptyMessage})

		return
	}

	if req.Location != nil && !validCoords(req.Location.Lat, req.Location.Lng) {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "invalid coordinates"})

		return
	}

	msg, err := h.store.AddThreadMessage(threadID, user.ID, user.Nick, req.Text, req.ID, req.ReplyToID, req.Location)
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

func (h *Handler) EditThreadMessage(w http.ResponseWriter, r *http.Request) { //nolint:gocognit,gocyclo
	defer r.Body.Close() //nolint:errcheck

	user := getUser(r)
	threadID := r.PathValue("threadId")
	messageID := r.PathValue("messageId")

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

	if h.cfg.MessageEditTTL < 0 {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "editing not allowed"})

		return
	}

	if h.cfg.MessageEditTTL > 0 {
		existing, err := h.store.GetMessage(threadID, messageID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

			return
		}

		if time.Since(existing.CreatedAt) > time.Duration(h.cfg.MessageEditTTL)*time.Second {
			writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "edit window expired"})

			return
		}
	}

	var req struct {
		Text     string          `json:"text"`
		FileIDs  []string        `json:"fileIDs,omitempty"`
		Location json.RawMessage `json:"location"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	location, clearLocation, locErr := parseLocationPatch(req.Location)
	if locErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: locErr.Error()})

		return
	}

	req.Text = strings.TrimSpace(req.Text)

	hasLocation := location != nil

	if req.Text == "" && len(req.FileIDs) == 0 && !hasLocation && !clearLocation {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyEmptyMessage})

		return
	}

	updated, err := h.store.EditThreadMessage(threadID, messageID, user.ID, req.Text, location, clearLocation)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{mapKeyError: err.Error()})

		return
	}

	if req.FileIDs != nil {
		if err := h.store.SetMessageFiles(messageID, req.FileIDs); err != nil {
			log.Printf("failed to set thread message files: %v", err)
		}

		files, _ := h.store.GetMessageFiles(messageID) //nolint:errcheck
		updated.Files = files
	}

	if chat.RemoteServer != "" {
		fedURL := h.federatedURL(chat.RemoteServer, "/api/federated/chats/"+thread.ChatID+"/threads/"+threadID+"/messages/"+messageID)

		fedBody := map[string]interface{}{
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
			log.Printf("federated edit thread message failed: %v", fedErr)
		}
	}

	eventData := map[string]interface{}{
		"threadId": threadID,
		"message":  &updated,
	}

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, SSEEvent{Event: "thread_message_updated", Data: eventData})
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"message": &updated})
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
