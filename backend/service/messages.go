package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/sse"
)

// Message domain errors. Handlers map a specific error to an HTTP status and a
// stable user-facing message; the service never depends on the transport.
var (
	ErrEmptyMessage        = errors.New("empty message")
	ErrMessageTooLong      = errors.New("message too long")
	ErrInvalidCoordinates  = errors.New("invalid coordinates")
	ErrTooManyFiles        = errors.New("too many files")
	ErrThreadNotFound      = errors.New("thread not found")
	ErrMessageNotFound     = errors.New("message not found")
	ErrNotYourMessage      = errors.New("not your message")
	ErrEditingNotAllowed   = errors.New("editing not allowed")
	ErrEditWindowExpired   = errors.New("edit window expired")
	ErrDeletingNotAllowed  = errors.New("deleting not allowed")
	ErrDeleteWindowExpired = errors.New("delete window expired")
	ErrDeleteForbidden     = errors.New("forbidden")
	ErrThreadOnThread      = errors.New("cannot create thread on a thread message")
	ErrThreadAlreadyExists = errors.New("thread already exists")
	ErrReadInputRequired   = errors.New("messageIds and chatId are required")
	ErrTooManyReadIDs      = errors.New("too many message IDs")
)

// E2E payload validation errors. The server does not decrypt messages but
// verifies the envelope shape so garbage does not pollute storage.
var (
	ErrMissingEncryptedPayload   = errors.New("missing encrypted payload")
	ErrEncryptedPayloadTooLarge  = errors.New("encrypted payload too large")
	ErrInvalidEncryptedPayload   = errors.New("invalid encrypted payload JSON")
	ErrUnsupportedPayloadVersion = errors.New("unsupported encrypted payload version")
	ErrInvalidNonce              = errors.New("invalid nonce")
	ErrMissingEnvelopes          = errors.New("missing envelopes")
	ErrEmptyKeyID                = errors.New("empty keyId in envelope")
	ErrInvalidBox                = errors.New("invalid box in envelope")
)

const (
	DefaultMessagesLimit = 30
	MaxMessagesLimit     = 100
	MaxMessageLen        = 10000
	// EncryptedMaxLen bounds E2E ciphertext: base64 of (plaintext + 16-byte
	// tag); a generous cap so server-side validation still rejects absurd
	// payloads while the plaintext length is enforced client-side first.
	EncryptedMaxLen  = 100000
	MaxMessageFiles  = 10
	MaxReadByMembers = 100

	// MaxEncryptedPayloadLen is the maximum size of encryptedPayload JSON.
	// A typical 2-person chat payload is ~200 bytes; 32KB is generous.
	MaxEncryptedPayloadLen = 32768
	// xchachaNonceLen is libsodium crypto_aead_xchacha20poly1305_ietf_NPUBBYTES.
	xchachaNonceLen = 24
	// sealedBoxLen is a sealed X25519 box: ephemeral public key + MAC.
	sealedBoxLen = 48
)

// Realtime event names and payload keys used by the message domain.
const (
	eventNewMessage       = "new_message"
	eventThreadMessageNew = "thread_message_new"
	eventMessageDelivered = "message_delivered"
	eventMessageUpdated   = "message_updated"
	eventThreadMessageUpd = "thread_message_updated"
	eventMessageDeleted   = "message_deleted"
	eventMessageRead      = "message_read"
	eventThreadCreated    = "thread_created"

	keyMessage   = "message"
	keyMessageID = "messageId"
	keyThreadID  = "threadId"
	keyReaderID  = "readerId"
	keyReadAt    = "readAt"
)

// MessageWithStatus extends a Message with delivery/read metadata shown to
// the requesting user. Its JSON shape matches the pre-migration transport DTO.
type MessageWithStatus struct {
	model.Message
	DeliveryStatus string   `json:"deliveryStatus,omitempty"`
	ReadBy         []string `json:"readBy,omitempty"`
}

// SendMessageInput carries the validated, decoded fields of a send request.
type SendMessageInput struct {
	ID               string
	Text             string
	ReplyToID        string
	FileIDs          []string
	FileHashes       []string
	Location         *model.Location
	Encrypted        bool
	EncryptedPayload string
}

// EditPayload holds the resolved fields of a message edit after the request
// was decoded and patch semantics applied.
type EditPayload struct {
	Text                string
	FileIDs             []string
	FileHashes          []string
	RawLocation         json.RawMessage
	Location            *model.Location
	ClearLocation       bool
	Encrypted           bool
	EncryptedPayload    string
	EncryptedPtr        *bool
	EncryptedPayloadPtr *string
}

// DecodedEditRequest is the JSON-decoded form of an edit request, before the
// store-fallback and patch semantics have been applied.
type DecodedEditRequest struct {
	Text             string          `json:"text"`
	FileIDs          []string        `json:"fileIDs,omitempty"`
	FileHashes       []string        `json:"fileHashes,omitempty"`
	Location         json.RawMessage `json:"location"`
	ClearLocation    bool            `json:"clearLocation"`
	Encrypted        *bool           `json:"encrypted"`
	EncryptedPayload *string         `json:"encryptedPayload"`
}

// ParseEditPayload applies the effective encryption fields, keeping stored
// values when the client omitted them (old clients, location-only edits). It
// validates only what the client sent; store fallbacks were already accepted
// at creation time. The returned error carries a client-safe message.
func ParseEditPayload(req *DecodedEditRequest, storedEncrypted bool, storedPayload string) (*EditPayload, error) {
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
	// already accepted when the message was created, so values
	// must not block edits of the text/location.
	if req.Encrypted != nil || req.EncryptedPayload != nil {
		if err := ValidateEncryptedPayload(encrypted, payload); err != nil {
			return nil, err
		}
	}

	location, clearLocation, locErr := parseLocationPatch(req.Location)
	if locErr != nil {
		return nil, locErr
	}
	// clearLocation from the request takes precedence (new clients send it
	// when the encrypted content no longer carries a location).
	if req.ClearLocation {
		clearLocation = true
	}

	text := strings.TrimSpace(req.Text)

	maxLen := MaxMessageLen
	if encrypted {
		maxLen = EncryptedMaxLen
	}
	if utf8.RuneCountInString(text) > maxLen {
		return nil, ErrMessageTooLong
	}

	if len(req.FileIDs) > MaxMessageFiles {
		return nil, ErrTooManyFiles
	}

	return &EditPayload{
		Text:                text,
		FileIDs:             req.FileIDs,
		FileHashes:          req.FileHashes,
		RawLocation:         req.Location,
		Location:            location,
		ClearLocation:       clearLocation,
		Encrypted:           encrypted,
		EncryptedPayload:    payload,
		EncryptedPtr:        req.Encrypted,
		EncryptedPayloadPtr: req.EncryptedPayload,
	}, nil
}

// ValidateEncryptedPayload checks the structure and size of an encrypted
// payload envelope. It never decrypts.
func ValidateEncryptedPayload(encrypted bool, payload string) error {
	if !encrypted {
		return nil
	}

	if payload == "" {
		return ErrMissingEncryptedPayload
	}

	if len(payload) > MaxEncryptedPayloadLen {
		return ErrEncryptedPayloadTooLarge
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
		return ErrInvalidEncryptedPayload
	}

	if data.V != 1 {
		return ErrUnsupportedPayloadVersion
	}

	// XChaCha20 nonce is exactly 24 bytes (libsodium
	// crypto_aead_xchacha20poly1305_ietf_NPUBBYTES).
	nonceRaw, err := base64.StdEncoding.DecodeString(data.Nonce)
	if err != nil || len(nonceRaw) != xchachaNonceLen {
		return ErrInvalidNonce
	}

	if len(data.Envelopes) == 0 {
		return ErrMissingEnvelopes
	}

	// Sealed boxes are 48 bytes: 32-byte ephemeral key + 16-byte MAC.
	for _, e := range data.Envelopes {
		if e.KeyID == "" {
			return ErrEmptyKeyID
		}
		boxRaw, err := base64.StdEncoding.DecodeString(e.Box)
		if err != nil || len(boxRaw) != sealedBoxLen {
			return ErrInvalidBox
		}
	}

	return nil
}

// ValidateSendInput validates the common send constraints shared between
// plain and thread sends. The text is trimmed in place.
func (s *Service) ValidateSendInput(input *SendMessageInput) error {
	input.Text = strings.TrimSpace(input.Text)

	if input.Text == "" && len(input.FileIDs) == 0 && len(input.FileHashes) == 0 && input.Location == nil {
		return ErrEmptyMessage
	}

	maxLen := MaxMessageLen
	if input.Encrypted {
		maxLen = EncryptedMaxLen
	}

	if utf8.RuneCountInString(input.Text) > maxLen {
		return ErrMessageTooLong
	}

	if input.Location != nil && !ValidCoords(input.Location.Lat, input.Location.Lng) {
		return ErrInvalidCoordinates
	}

	return nil
}

// EnrichOwnMessage builds the message-with-status view of a message the
// requesting user authored.
func (s *Service) EnrichOwnMessage(
	msg *model.Message,
	deliveryStatuses map[string]string,
	readersByMsg map[string][]string,
	showReadBy bool,
) MessageWithStatus {

	result := MessageWithStatus{Message: *msg}

	status := "sent"
	if st, ok := deliveryStatuses[msg.ID]; ok {
		status = st
	}
	result.DeliveryStatus = status
	if showReadBy {
		if readers, ok := readersByMsg[msg.ID]; ok {
			result.ReadBy = readers
		}
	}

	return result
}

// EnrichMessagesWithStatuses decorates messages with files and read/delivery
// metadata for the requesting user. Returns nil when messages is empty so the
// transport can fall back to the raw (empty) list.
func (s *Service) EnrichMessagesWithStatuses(
	ctx context.Context,
	messages []model.Message,
	chat *model.Chat,
	userID string,
	missingIDs []string,
) []MessageWithStatus {

	if len(messages) == 0 {
		return nil
	}

	ids := make([]string, len(messages))
	for i := range messages {
		ids[i] = messages[i].ID
	}

	filesByMsg, err := s.store.GetMessageFilesBatch(ctx, ids)
	if err == nil {
		for i := range messages {
			messages[i].Files = filesByMsg[messages[i].ID]
		}
	}

	// Only fetch statuses for messages that are missing from client cache.
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

	readStatuses, _ := s.store.GetMessageReadStatusesBatch(ctx, statusIDs, userID)    //nolint:errcheck // best-effort: failure is not actionable
	deliveryStatuses, _ := s.store.GetMessageDeliveryStatuses(ctx, statusIDs, userID) //nolint:errcheck // best-effort: failure is not actionable

	showReadBy := len(chat.Members) <= MaxReadByMembers
	var readersByMsg map[string][]string
	if showReadBy {
		readersByMsg, _ = s.store.GetMessageReadStatusesForSender(ctx, statusIDs, userID) //nolint:errcheck // best-effort: failure is not actionable
	}

	result := make([]MessageWithStatus, len(messages))
	for idx := range messages {
		msg := messages[idx]
		result[idx] = MessageWithStatus{Message: msg}

		if msg.FromID == userID {
			result[idx] = s.EnrichOwnMessage(&msg, deliveryStatuses, readersByMsg, showReadBy)
		} else if status, ok := readStatuses[msg.ID]; ok {
			// Other's message: show read status for current user.
			result[idx].DeliveryStatus = status
		}
	}

	return result
}

// GetMessages returns a page of messages with status enrichment. It returns
// the enriched list (nil-safe) and the next-cursor; when enrichment yields
// nil (empty page) the transport falls back to the empty raw list.
func (s *Service) GetMessages(
	ctx context.Context,
	chat *model.Chat,
	userID string,
	limit int,
	before string,
	missingIDs []string,
) ([]MessageWithStatus, string) {

	messages, nextCursor, _ := s.store.GetMessagesPaginated(ctx, chat.ID, limit, before)

	result := s.EnrichMessagesWithStatuses(ctx, messages, chat, userID, missingIDs)

	return result, nextCursor
}

// GetThreadMessages returns a page of thread messages with files attached.
func (s *Service) GetThreadMessages(ctx context.Context, threadID string, limit int, before string) ([]model.Message, string) {
	messages, nextCursor, _ := s.store.GetThreadMessagesPaginated(ctx, threadID, limit, before)

	if len(messages) > 0 {
		ids := make([]string, len(messages))
		for i := range messages {
			ids[i] = messages[i].ID
		}

		filesByMsg, err := s.store.GetMessageFilesBatch(ctx, ids)
		if err == nil {
			for i := range messages {
				messages[i].Files = filesByMsg[messages[i].ID]
			}
		}
	}

	return messages, nextCursor
}

// SendMessage validates and persists a message, resolves file hashes, links
// the attached files and notifies all members over the realtime hub.
func (s *Service) SendMessage(
	ctx context.Context,
	chat *model.Chat,
	threadID string,
	chatID string,
	fromID string,
	fromNick string,
	input *SendMessageInput,
) (*model.Message, error) {

	if err := ValidateEncryptedPayload(input.Encrypted, input.EncryptedPayload); err != nil {
		return nil, err
	}

	if err := s.ValidateSendInput(input); err != nil {
		return nil, err
	}

	// Resolve file hashes to existing file IDs. The client sends hashes for
	// files that already exist on server (deduplication) to skip re-uploading.
	for _, hash := range input.FileHashes {
		if file, ok := s.store.FindFileByHash(ctx, hash); ok {
			input.FileIDs = append(input.FileIDs, file.ID)
		}
	}

	if len(input.FileIDs) > MaxMessageFiles {
		return nil, ErrTooManyFiles
	}

	msg, err := s.store.AddMessage(
		ctx, chatID, threadID, fromID, fromNick, input.Text,
		input.ID, input.ReplyToID, input.Location, input.Encrypted, input.EncryptedPayload,
	)
	if err != nil {
		return nil, err
	}

	if len(input.FileIDs) > 0 {
		if err := s.store.AddMessageFiles(ctx, msg.ID, input.FileIDs); err != nil {
			log().Info("failed to link files to message", "err", err)
		}

		files, _ := s.store.GetMessageFiles(ctx, msg.ID) //nolint:errcheck // best-effort: failure is not actionable
		msg.Files = files
	}

	s.notifyMessageSent(ctx, chat, msg, threadID, chatID, fromID)

	return msg, nil
}

// notifyMessageSent broadcasts a new message to all chat members and marks it
// delivered for the non-sender recipients. Delivery tracking is best-effort.
func (s *Service) notifyMessageSent(ctx context.Context, chat *model.Chat, msg *model.Message, threadID, chatID, senderID string) {
	eventName := eventNewMessage
	eventData := map[string]any{keyMessage: msg}
	if threadID != "" {
		eventName = eventThreadMessageNew
		eventData = map[string]any{keyThreadID: threadID, keyMessage: msg}
	}

	for _, memberID := range chat.Members {
		s.hub.Send(memberID, sse.Event{Event: eventName, Data: eventData})

		if memberID == senderID {
			continue
		}

		// Mark as delivered for other members (ignore errors - best effort).
		_ = s.store.MarkMessagesDelivered(ctx, []string{msg.ID}, memberID) //nolint:errcheck // best-effort: failure is not actionable
		// Notify sender about delivery.
		s.hub.Send(senderID, sse.Event{
			Event: eventMessageDelivered,
			Data: map[string]any{
				keyMessageID: msg.ID,
				keyChatID:    chatID,
			},
		})
	}
}

// EditMessage loads, authorizes and edits a message, resolving file hashes
// and setting files. It returns the updated message plus the resolved edit
// payload so the transport can fan out federation/push payloads unchanged.
func (s *Service) EditMessage(
	ctx context.Context,
	chatID string,
	threadID string,
	messageID string,
	userID string,
	req *DecodedEditRequest,
	editTTL int,
) (model.Message, EditPayload, error) {
	// For thread messages the transport has already resolved ChatID from the
	// thread; the store looks the message up in the thread bucket when a
	// threadID is present.
	lookupID := chatID
	if threadID != "" {
		lookupID = threadID
	}

	msg, err := s.store.GetMessage(ctx, lookupID, messageID)
	if err != nil {
		return model.Message{}, EditPayload{}, ErrMessageNotFound
	}

	if msg.FromID != userID {
		return model.Message{}, EditPayload{}, ErrNotYourMessage
	}

	if editTTL < 0 {
		return model.Message{}, EditPayload{}, ErrEditingNotAllowed
	}

	if editTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(editTTL)*time.Second {
		return model.Message{}, EditPayload{}, ErrEditWindowExpired
	}

	edit, err := ParseEditPayload(req, msg.Encrypted, msg.EncryptedPayload)
	if err != nil {
		return model.Message{}, EditPayload{}, err
	}

	hasLocation := edit.Location != nil

	if edit.Text == "" && len(edit.FileIDs) == 0 && len(edit.FileHashes) == 0 && !hasLocation && !edit.ClearLocation {
		return model.Message{}, EditPayload{}, ErrEmptyMessage
	}

	updated, err := s.store.EditMessage(
		ctx, chatID, threadID, messageID, userID, edit.Text,
		edit.Location, edit.ClearLocation, edit.EncryptedPtr, edit.EncryptedPayloadPtr,
	)
	if err != nil {
		return model.Message{}, EditPayload{}, err
	}

	// Resolve file hashes to existing file IDs (files already on server).
	for _, hash := range edit.FileHashes {
		if file, ok := s.store.FindFileByHash(ctx, hash); ok {
			edit.FileIDs = append(edit.FileIDs, file.ID)
		}
	}

	if edit.FileIDs != nil {
		if err := s.store.SetMessageFiles(ctx, messageID, edit.FileIDs); err != nil {
			log().Info("failed to set message files", "err", err)
		}

		files, _ := s.store.GetMessageFiles(ctx, messageID) //nolint:errcheck // best-effort: failure is not actionable
		updated.Files = files
	}

	return updated, *edit, nil
}

// BroadcastMessageUpdated fans out an edit/update event to every chat member.
func (s *Service) BroadcastMessageUpdated(_ context.Context, chat *model.Chat, threadID string, message *model.Message) {
	if threadID != "" {
		eventData := map[string]any{
			keyThreadID: threadID,
			keyMessage:  message,
		}
		for _, memberID := range chat.Members {
			s.hub.Send(memberID, sse.Event{Event: eventThreadMessageUpd, Data: eventData})
		}

		return
	}

	for _, memberID := range chat.Members {
		s.hub.Send(memberID, sse.Event{Event: eventMessageUpdated, Data: message})
	}
}

// DeleteMessage loads, authorizes and deletes a message, broadcasting the
// tombstones to every member.
func (s *Service) DeleteMessage(ctx context.Context, chat *model.Chat, chatID, messageID, userID string, deleteTTL int) error {
	msg, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil {
		return ErrMessageNotFound
	}

	if msg.FromID != userID {
		return ErrNotYourMessage
	}

	if deleteTTL < 0 {
		return ErrDeletingNotAllowed
	}

	if deleteTTL > 0 && time.Since(msg.CreatedAt) > time.Duration(deleteTTL)*time.Second {
		return ErrDeleteWindowExpired
	}

	if err := s.store.DeleteMessage(ctx, chatID, messageID, userID); err != nil {
		return ErrDeleteForbidden
	}

	for _, memberID := range chat.Members {
		s.hub.Send(memberID, sse.Event{Event: eventMessageDeleted, Data: map[string]string{keyChatID: chatID, keyMessageID: messageID}})
	}

	return nil
}

// MarkMessagesRead marks a batch of messages read by the user and notifies
// every distinct author (excluding self) with a read receipt.
func (s *Service) MarkMessagesRead(ctx context.Context, chatID, userID string, messageIDs []string) error {
	if len(messageIDs) == 0 || chatID == "" {
		return ErrReadInputRequired
	}

	if len(messageIDs) > 100 {
		return ErrTooManyReadIDs
	}

	// Get messages filtered by chat ID to verify ownership.
	messages, err := s.store.GetMessagesByIDs(ctx, messageIDs, chatID)
	if err != nil {
		return err
	}

	validIDs := make([]string, len(messages))
	for i := range messages {
		validIDs[i] = messages[i].ID
	}

	if err := s.store.MarkMessagesRead(ctx, validIDs, userID); err != nil {
		return err
	}

	// Collect unique authors (excluding self).
	authors := make(map[string]bool)
	for i := range messages {
		if messages[i].FromID != userID {
			authors[messages[i].FromID] = true
		}
	}

	now := time.Now().UTC()
	for authorID := range authors {
		var authorMsgIDs []string
		for i := range messages {
			if messages[i].FromID == authorID {
				authorMsgIDs = append(authorMsgIDs, messages[i].ID)
			}
		}

		for _, msgID := range authorMsgIDs {
			s.hub.Send(authorID, sse.Event{
				Event: eventMessageRead,
				Data: map[string]any{
					keyMessageID: msgID,
					keyReaderID:  userID,
					keyReadAt:    now,
				},
			})
		}
	}

	return nil
}

// CreateThread validates the parent message and creates a thread, broadcasting
// thread_created to every chat member.
func (s *Service) CreateThread(ctx context.Context, chat *model.Chat, chatID, messageID string) (*model.Thread, error) {
	msg, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil {
		return nil, ErrMessageNotFound
	}

	if _, exists := s.store.GetThread(ctx, chatID); exists {
		return nil, ErrThreadOnThread
	}

	if _, exists := s.store.GetThreadByParentMessage(ctx, chatID, messageID); exists {
		return nil, ErrThreadAlreadyExists
	}

	thread, err := s.store.CreateThread(ctx, chatID, messageID, msg.Text, msg.FromNick)
	if err != nil {
		return nil, err
	}

	for _, memberID := range chat.Members {
		s.hub.Send(memberID, sse.Event{Event: eventThreadCreated, Data: thread})
	}

	return thread, nil
}

// GetThreads returns all threads for a chat.
func (s *Service) GetThreads(ctx context.Context, chatID string) []model.Thread {
	return s.store.GetThreadsForChat(ctx, chatID)
}

// ValidCoords reports whether the coordinates are within WGS84 bounds.
func ValidCoords(lat, lng float64) bool {
	return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// parseLocationPatch mirrors the transport's location patch semantics: empty
// means "not sent", "null" clears, otherwise it validates bounds.
func parseLocationPatch(raw json.RawMessage) (*model.Location, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}

	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return nil, true, nil
	}

	var loc model.Location
	if err := json.Unmarshal(raw, &loc); err != nil {
		return nil, false, ErrInvalidCoordinates
	}

	if !ValidCoords(loc.Lat, loc.Lng) {
		return nil, false, ErrInvalidCoordinates
	}

	return &loc, false, nil
}
