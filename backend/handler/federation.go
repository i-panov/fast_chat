package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
)

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

	signature, err := h.fedManager.Sign(method, parsedURL.RequestURI(), bodyBytes, timestamp)
	if err != nil {
		return nil, fmt.Errorf("federation sign: %w", err)
	}

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

// authorizeFederatedSource verifies that the request is from the server
// that owns the given chat. It writes a 403 and returns false otherwise.
func authorizeFederatedSource(w http.ResponseWriter, chat *model.Chat, r *http.Request) bool {
	remoteServer := r.Header.Get("X-Federation-Server")
	if remoteServer == "" || chat.RemoteServer != remoteServer {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: errKeyNotMember})

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
		writeJSON(w, http.StatusOK, map[string]interface{}{"users": []model.PublicUser{}})

		return
	}

	users := h.store.SearchUsers(query, "")

	if users == nil {
		users = []model.PublicUser{}
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

	headerServer := r.Header.Get("X-Federation-Server")
	if headerServer == "" || req.RemoteServer != headerServer {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "remote server mismatch"})

		return
	}

	if !federatedChatMembersValid(req.Members, headerServer, h.fedManager.ServerDomain()) {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "members must belong to federation endpoints"})

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

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	var req struct {
		ID        string          `json:"id"`
		FromID    string          `json:"fromId"`
		FromNick  string          `json:"fromNick"`
		Text      string          `json:"text"`
		ReplyToID string          `json:"replyToId"`
		Location  *model.Location `json:"location,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: errKeyInvalidBody})

		return
	}

	if !userIDBelongsToServer(req.FromID, chat.RemoteServer) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "fromId does not belong to remote server"})

		return
	}

	if req.Location != nil && !validCoords(req.Location.Lat, req.Location.Lng) {
		writeJSON(w, http.StatusBadRequest, map[string]string{mapKeyError: "invalid coordinates"})

		return
	}

	msg := model.Message{
		ID:        req.ID,
		ChatID:    chatID,
		FromID:    req.FromID,
		FromNick:  req.FromNick,
		Text:      req.Text,
		CreatedAt: time.Now(),
		Location:  req.Location,
	}

	if req.ReplyToID != "" {
		if parent, err := h.store.GetMessage(chatID, req.ReplyToID); err == nil {
			msg.ReplyTo = &model.ReplyToInfo{
				MessageID: req.ReplyToID,
				Text:      parent.Text,
				FromNick:  parent.FromNick,
				Files:     h.store.GetMessageFilesForReply(parent.ID),
				Location:  parent.Location,
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
func (h *Handler) FederatedEditMessage(w http.ResponseWriter, r *http.Request) { //nolint:gocyclo
	defer r.Body.Close() //nolint:errcheck

	chatID := r.PathValue("id")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	stored, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

		return
	}

	if !userIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "message author does not belong to remote server"})

		return
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

	now := time.Now()

	if err := h.store.EditRawMessage(chatID, messageID, req.Text, now, location, clearLocation); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: err.Error()})

		return
	}

	if req.FileIDs != nil {
		if err := h.store.SetMessageFiles(messageID, req.FileIDs); err != nil {
			log.Printf("federated edit: failed to set message files: %v", err)
		}
	}

	updated := &model.Message{
		ID:       messageID,
		ChatID:   chatID,
		Text:     req.Text,
		EditedAt: &now,
	}

	if req.FileIDs != nil {
		files, _ := h.store.GetMessageFiles(messageID) //nolint:errcheck
		updated.Files = files
	}

	if len(req.Location) > 0 {
		if clearLocation {
			updated.Location = nil
		} else {
			updated.Location = location
		}
	} else if stored, gerr := h.store.GetMessage(chatID, messageID); gerr == nil {
		updated.Location = stored.Location
	}

	if chat != nil {
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

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	stored, err := h.store.GetMessage(chatID, messageID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

		return
	}

	if !userIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "message author does not belong to remote server"})

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

	if !authorizeFederatedSource(w, chat, r) {
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

	event := SSEEvent{Event: eventName, Data: payload}

	for _, memberID := range chat.Members {
		if memberID != req.UserID {
			h.hub.Send(memberID, event)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) FederatedEditThreadMessage(w http.ResponseWriter, r *http.Request) { //nolint:gocyclo
	defer r.Body.Close() //nolint:errcheck

	chatID := r.PathValue("id")
	threadID := r.PathValue("threadId")
	messageID := r.PathValue("messageId")

	chat, ok := h.store.GetChat(chatID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: errKeyChatNotFound})

		return
	}

	if !authorizeFederatedSource(w, chat, r) {
		return
	}

	stored, err := h.store.GetMessage(threadID, messageID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: "message not found"})

		return
	}

	if !userIDBelongsToServer(stored.FromID, chat.RemoteServer) {
		writeJSON(w, http.StatusForbidden, map[string]string{mapKeyError: "message author does not belong to remote server"})

		return
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

	now := time.Now()

	if err := h.store.EditRawMessage(threadID, messageID, req.Text, now, location, clearLocation); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{mapKeyError: err.Error()})

		return
	}

	if req.FileIDs != nil {
		if err := h.store.SetMessageFiles(messageID, req.FileIDs); err != nil {
			log.Printf("federated edit thread message: failed to set files: %v", err)
		}
	}

	updated := &model.Message{
		ID:       messageID,
		ChatID:   threadID,
		Text:     req.Text,
		EditedAt: &now,
	}

	if req.FileIDs != nil {
		files, _ := h.store.GetMessageFiles(messageID) //nolint:errcheck
		updated.Files = files
	}

	if len(req.Location) > 0 {
		if clearLocation {
			updated.Location = nil
		} else {
			updated.Location = location
		}
	} else if stored, gerr := h.store.GetMessage(threadID, messageID); gerr == nil {
		updated.Location = stored.Location
	}

	if chat != nil {
		eventData := map[string]interface{}{
			"threadId": threadID,
			"message":  updated,
		}

		for _, memberID := range chat.Members {
			h.hub.Send(memberID, SSEEvent{Event: "thread_message_updated", Data: eventData})
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"message": updated})
}
