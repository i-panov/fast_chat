package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
)

var (
	errMissingEncryptedPayload   = errors.New("missing encrypted payload")
	errEncryptedPayloadTooLarge  = errors.New("encrypted payload too large")
	errInvalidEncryptedPayload   = errors.New("invalid encrypted payload JSON")
	errUnsupportedPayloadVersion = errors.New("unsupported encrypted payload version")
	errInvalidNonce              = errors.New("invalid nonce")
	errMissingEnvelopes          = errors.New("missing envelopes")
	errEmptyKeyID                = errors.New("empty keyId in envelope")
	errInvalidBox                = errors.New("invalid box in envelope")
)

const (
	defaultMessagesLimit = 30
	maxMessagesLimit     = 100
	maxMessageLen        = 10000
	// E2E ciphertext is base64 of (plaintext + 16-byte tag); a generous
	// cap so server-side validation still rejects absurd payloads while
	// the plaintext length is enforced client-side before encryption.
	encryptedMaxLen  = 100000
	maxMessageFiles  = 10
	maxReadByMembers = 100

	// maxEncryptedPayloadLen is the maximum size of encryptedPayload JSON.
	// A typical 2-person chat payload is ~200 bytes; 32KB is generous.
	maxEncryptedPayloadLen = 32768

	// xchachaNonceLen is libsodium crypto_aead_xchacha20poly1305_ietf_NPUBBYTES.
	xchachaNonceLen = 24
	// sealedBoxLen is a sealed X25519 box: ephemeral public key + MAC.
	sealedBoxLen = 48
)

// validateEncryptedPayload checks the structure and size of the encrypted
// payload. The server does not decrypt messages but it verifies the
// envelope is well-formed so garbage does not pollute the storage.
func validateEncryptedPayload(encrypted bool, payload string) error {
	if !encrypted {
		return nil
	}

	if payload == "" {
		return errMissingEncryptedPayload
	}

	if len(payload) > maxEncryptedPayloadLen {
		return errEncryptedPayloadTooLarge
	}

	var data struct {
		V         int    `json:"v"`
		Nonce     string `json:"nonce"`
		Envelopes []struct {
			KeyID string `json:"keyId"`
			Box   string `json:"box"`
		} `json:"envelopes"`
	}

	if err := json.Unmarshal([]byte(payload), &data); err != nil {
		return errInvalidEncryptedPayload
	}

	if data.V != 1 {
		return errUnsupportedPayloadVersion
	}

	// XChaCha20 nonce is exactly 24 bytes (libsodium
	// crypto_aead_xchacha20poly1305_ietf_NPUBBYTES).
	nonceRaw, err := base64.StdEncoding.DecodeString(data.Nonce)
	if err != nil || len(nonceRaw) != xchachaNonceLen {
		return errInvalidNonce
	}

	if len(data.Envelopes) == 0 {
		return errMissingEnvelopes
	}

	// Sealed boxes are 48 bytes: 32-byte ephemeral key + 16-byte MAC
	// (crypto_box_SEALBYTES + crypto_box_PUBLICKEYBYTES).
	for _, e := range data.Envelopes {
		if e.KeyID == "" {
			return errEmptyKeyID
		}
		boxRaw, err := base64.StdEncoding.DecodeString(e.Box)
		if err != nil || len(boxRaw) != sealedBoxLen {
			return errInvalidBox
		}
	}

	return nil
}

type messageWithStatus struct {
	model.Message
	DeliveryStatus string   `json:"deliveryStatus,omitempty"`
	ReadBy         []string `json:"readBy,omitempty"`
}

// editPayload holds the resolved fields of a message edit request after
// parseEditPayload has applied the patch semantics and validation.
type editPayload struct {
	text                string
	fileIDs             []string
	rawLocation         json.RawMessage
	location            *model.Location
	clearLocation       bool
	encrypted           bool
	encryptedPayload    string
	encryptedPtr        *bool
	encryptedPayloadPtr *string
}

// parseEditPayload decodes an edit request and resolves the effective
// encryption fields, keeping the stored values when the client omitted
// them (old clients, location-only edits). The raw request pointers are
// preserved so the store's patch semantics can distinguish "not sent"
// from "explicit value". The returned error message is safe to surface.
func (h *Handler) parseEditPayload(r *http.Request, storedEncrypted bool, storedPayload string) (*editPayload, string) {
	var req struct {
		Text             string          `json:"text"`
		FileIDs          []string        `json:"fileIDs,omitempty"`
		Location         json.RawMessage `json:"location"`
		Encrypted        *bool           `json:"encrypted"`
		EncryptedPayload *string         `json:"encryptedPayload"`
	}

	if err := h.decodeJSON(r, &req); err != nil {
		return nil, errKeyInvalidBody
	}

	encrypted := req.Encrypted != nil && *req.Encrypted
	payload := ""
	if req.EncryptedPayload != nil {
		payload = *req.EncryptedPayload
	}

	if req.Encrypted == nil {
		encrypted = storedEncrypted
	}
	if req.EncryptedPayload == nil {
		payload = storedPayload
	}

	// Validate only what the client sent. Fallbacks from the store were
	// already accepted when the message was created, so legacy values
	// must not block edits of the text/location.
	if req.Encrypted != nil || req.EncryptedPayload != nil {
		if err := validateEncryptedPayload(encrypted, payload); err != nil {
			return nil, err.Error()
		}
	}

	location, clearLocation, locErr := parseLocationPatch(req.Location)
	if locErr != nil {
		return nil, locErr.Error()
	}

	text := strings.TrimSpace(req.Text)

	maxLen := maxMessageLen
	if encrypted {
		maxLen = encryptedMaxLen
	}
	if utf8.RuneCountInString(text) > maxLen {
		return nil, "message too long"
	}

	if len(req.FileIDs) > maxMessageFiles {
		return nil, "too many files"
	}

	return &editPayload{
		text:                text,
		fileIDs:             req.FileIDs,
		rawLocation:         req.Location,
		location:            location,
		clearLocation:       clearLocation,
		encrypted:           encrypted,
		encryptedPayload:    payload,
		encryptedPtr:        req.Encrypted,
		encryptedPayloadPtr: req.EncryptedPayload,
	}, ""
}

func (h *Handler) enrichOwnMessage(
	msg model.Message,
	deliveryStatuses map[string]string,
	readersByMsg map[string][]string,
	showReadBy bool,
) messageWithStatus {

	result := messageWithStatus{Message: msg}
	status := "sent"
	if s, ok := deliveryStatuses[msg.ID]; ok {
		status = s
	}
	result.DeliveryStatus = status
	if showReadBy {
		if readers, ok := readersByMsg[msg.ID]; ok {
			result.ReadBy = readers
		}
	}
	return result
}

func (h *Handler) enrichMessagesWithStatuses(
	ctx context.Context,
	messages []model.Message,
	chat *model.Chat,
	userID string,
	missingIDs []string,
) []messageWithStatus {

	if len(messages) == 0 {
		return nil
	}

	ids := make([]string, len(messages))
	for i, m := range messages {
		ids[i] = m.ID
	}

	filesByMsg, err := h.store.GetMessageFilesBatch(ctx, ids)
	if err == nil {
		for i := range messages {
			messages[i].Files = filesByMsg[messages[i].ID]
		}
	}

	// Only fetch statuses for messages that are missing from client cache
	statusIDs := ids
	if len(missingIDs) > 0 {
		missingSet := make(map[string]bool, len(missingIDs))
		for _, id := range missingIDs {
			missingSet[id] = true
		}
		statusIDs = make([]string, 0, len(missingIDs))
		for _, id := range ids {
			if missingSet[id] {
				statusIDs = append(statusIDs, id)
			}
		}
	}

	readStatuses, _ := h.store.GetMessageReadStatusesBatch(ctx, statusIDs, userID)    //nolint:errcheck // best-effort: failure is not actionable
	deliveryStatuses, _ := h.store.GetMessageDeliveryStatuses(ctx, statusIDs, userID) //nolint:errcheck // best-effort: failure is not actionable

	showReadBy := len(chat.Members) <= maxReadByMembers
	var readersByMsg map[string][]string
	if showReadBy {
		readersByMsg, _ = h.store.GetMessageReadStatusesForSender(ctx, statusIDs, userID) //nolint:errcheck // best-effort: failure is not actionable
	}

	result := make([]messageWithStatus, len(messages))
	for i, msg := range messages {
		result[i] = messageWithStatus{Message: msg}

		if msg.FromID == userID {
			result[i] = h.enrichOwnMessage(msg, deliveryStatuses, readersByMsg, showReadBy)
		} else if status, ok := readStatuses[msg.ID]; ok {
			// Other's message: show read status for current user
			result[i].DeliveryStatus = status
		}
	}

	return result
}

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

	result := h.enrichMessagesWithStatuses(r.Context(), messages, chat, user.ID, nil)
	if result != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"messages":   result,
			"nextCursor": nextCursor,
		})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   messages,
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
	if limit <= 0 || limit > maxMessagesLimit {
		limit = defaultMessagesLimit
	}

	messages, nextCursor, _ := h.store.GetMessagesPaginated(r.Context(), chatID, limit, req.Before)
	if messages == nil {
		messages = []model.Message{}
	}

	result := h.enrichMessagesWithStatuses(r.Context(), messages, chat, user.ID, req.MissingIDs)
	if result != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"messages":   result,
			"nextCursor": nextCursor,
		})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"messages":   messages,
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

	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" && len(req.FileIDs) == 0 && req.Location == nil {
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

	msg, err := h.store.AddMessage(
		r.Context(), chatID, threadID, user.ID, user.Nick, req.Text,
		req.ID, req.ReplyToID, req.Location, req.Encrypted, req.EncryptedPayload,
	)
	if err != nil {
		slog.Error("failed to send message", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if len(req.FileIDs) > 0 {
		if err := h.store.AddMessageFiles(r.Context(), msg.ID, req.FileIDs); err != nil {
			logger.Info("failed to link files to message", "err", err)
		}

		files, _ := h.store.GetMessageFiles(r.Context(), msg.ID) //nolint:errcheck // best-effort: failure is not actionable
		msg.Files = files
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

	eventName := "new_message"
	eventData := map[string]any{"message": msg}
	if threadID != "" {
		eventName = "thread_message_new"
		eventData = map[string]any{"threadId": threadID, "message": msg}
	}

	h.notifyMessageSent(r, chat, msg, threadID, chatID, user.ID, eventName, eventData)

	WriteJSON(w, http.StatusCreated, map[string]any{"message": msg})
}

// notifyMessageSent broadcasts a new message to all chat members and
// pushes it to remote devices. Delivery tracking is best-effort.
func (h *Handler) notifyMessageSent(
	r *http.Request,
	chat *model.Chat,
	msg *model.Message,
	threadID, chatID, senderID string,
	eventName string,
	eventData map[string]any,
) {

	for _, memberID := range chat.Members {
		h.hub.Send(memberID, sse.Event{Event: eventName, Data: eventData})

		if memberID == senderID {
			continue
		}

		// Mark as delivered for other members (ignore errors - best effort)
		_ = h.store.MarkMessagesDelivered(r.Context(), []string{msg.ID}, memberID) //nolint:errcheck // best-effort: failure is not actionable
		// Notify sender about delivery
		h.hub.Send(senderID, sse.Event{
			Event: "message_delivered",
			Data: map[string]any{
				"messageId": msg.ID,
				"chatId":    chatID,
			},
		})
		h.sendPushForMessage(r.Context(), chatID, msg, threadID, memberID)
	}
}

func (h *Handler) EditMessage(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close() //nolint:errcheck // best-effort: failure is not actionable

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

	edit, errMsg := h.parseEditPayload(r, msg.Encrypted, msg.EncryptedPayload)
	if errMsg != "" {
		writeError(w, http.StatusBadRequest, errMsg)
		return
	}

	hasLocation := edit.location != nil

	if edit.text == "" && len(edit.fileIDs) == 0 && !hasLocation && !edit.clearLocation {
		writeError(w, http.StatusBadRequest, errKeyEmptyMessage)
		return
	}

	updated, err := h.store.EditMessage(
		r.Context(), chatID, threadID, messageID, user.ID, edit.text,
		edit.location, edit.clearLocation, edit.encryptedPtr, edit.encryptedPayloadPtr,
	)
	if err != nil {
		slog.Error("failed to edit message", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if edit.fileIDs != nil {
		if err := h.store.SetMessageFiles(r.Context(), messageID, edit.fileIDs); err != nil {
			logger.Info("failed to set message files", "err", err)
		}

		files, _ := h.store.GetMessageFiles(r.Context(), messageID) //nolint:errcheck // best-effort: failure is not actionable
		updated.Files = files
	}

	if threadID != "" {
		h.sendFedPatch(r.Context(), chat.RemoteServer, "/api/federated/chats/"+chatID+"/threads/"+threadID+"/messages/"+messageID, map[string]any{
			"text":             edit.text,
			"fileIDs":          edit.fileIDs,
			"location":         edit.rawLocation,
			"encrypted":        edit.encrypted,
			"encryptedPayload": edit.encryptedPayload,
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
			"text":             edit.text,
			"fileIDs":          edit.fileIDs,
			"location":         edit.rawLocation,
			"encrypted":        edit.encrypted,
			"encryptedPayload": edit.encryptedPayload,
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

	// Get messages filtered by chat ID to verify ownership
	messages, err := h.store.GetMessagesByIDs(r.Context(), req.MessageIDs, req.ChatID)
	if err != nil {
		slog.Error("failed to get messages for read", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Extract valid message IDs
	validIDs := make([]string, len(messages))
	for i, msg := range messages {
		validIDs[i] = msg.ID
	}

	// Mark messages as read
	if err := h.store.MarkMessagesRead(r.Context(), validIDs, user.ID); err != nil {
		slog.Error("failed to mark messages as read", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Collect unique authors (excluding self)
	authors := make(map[string]bool)
	for _, msg := range messages {
		if msg.FromID != user.ID {
			authors[msg.FromID] = true
		}
	}

	// Notify each author about read messages
	now := time.Now().UTC()
	for authorID := range authors {
		// Find messages from this author
		var authorMsgIDs []string
		for _, msg := range messages {
			if msg.FromID == authorID {
				authorMsgIDs = append(authorMsgIDs, msg.ID)
			}
		}

		for _, msgID := range authorMsgIDs {
			h.hub.Send(authorID, sse.Event{
				Event: "message_read",
				Data: map[string]any{
					"messageId": msgID,
					"readerId":  user.ID,
					"readAt":    now,
				},
			})
		}
	}

	WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
