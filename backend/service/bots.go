package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"fast_chat/federation"
	"fast_chat/internal/ids"
	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

const (
	keyFrom             = "from"
	keyText             = "text"
	keyEncrypted        = "encrypted"
	keyEncryptedPayload = "encryptedPayload"
	keyLocation         = "location"
	keyFiles            = "files"
	// EncryptionModeServer is the plaintext bot mode.
	EncryptionModeServer = "server"
	// EncryptionModeE2EE is the end-to-end encrypted bot mode.
	EncryptionModeE2EE = "e2ee"
)

// MaxBotsPerOwner bounds how many bot identities one account can create.
const MaxBotsPerOwner = 20

var (
	ErrBotUsernameInvalid     = errors.New("bot username must match the username rules and end with _bot")
	ErrBotQuotaExceeded       = errors.New("bot limit reached")
	ErrBotUsernameTaken       = errors.New("bot username taken")
	ErrBotUsernameReserved    = errors.New("bot username reserved")
	ErrBotOwnerRequired       = errors.New("bot owner is required")
	ErrBotNotActive           = errors.New("bot is not active")
	ErrBotSelfChat            = errors.New("cannot open a bot chat with a bot")
	ErrBotMarkupInvalid       = errors.New("invalid inline keyboard")
	ErrBotEncryptionRequired  = errors.New("encrypted message required for this bot")
	ErrBotEncryptionForbidden = errors.New("plaintext message required for this bot")
	ErrBotActionInvalid       = errors.New("unsupported bot action")
	ErrBotAttachmentRemote    = errors.New("inline keyboards and locations are not supported for federated bot chats")
	ErrBotGroupMember         = errors.New("bots can only be used in 1-1 chats")
	ErrBotKeysAlreadySet      = errors.New("bot already has E2EE keys")
	ErrBotDisplayNameInvalid  = errors.New("bot display name is too long")
	ErrBotAnswerTooLong       = errors.New("callback answer is too long")
)

const (
	// maxBotDisplayNameRunes mirrors the human display-name limit: the name is
	// copied into every chat list and message the bot appears in.
	maxBotDisplayNameRunes = 64
	// maxBotCallbackAnswerRunes mirrors the Telegram limit for the text of a
	// callback answer. The text is pushed to the user over SSE.
	maxBotCallbackAnswerRunes = 200
	// botPollInterval is how often a long poll re-checks the update table.
	botPollInterval = 100 * time.Millisecond
)

var botBaseRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_]{0,26}[a-z0-9])?$`)

// ParseBotUsername validates the bot-specific suffix and the shared username
// body. The total length includes the "_bot" suffix.
func ParseBotUsername(username string) (string, bool) {
	username = strings.ToLower(strings.TrimSpace(username))
	if len(username) < 6 || len(username) > 32 || !strings.HasSuffix(username, "_bot") {
		return "", false
	}
	base := strings.TrimSuffix(username, "_bot")
	// Apply the shared username rules to the base, minus the 3-rune minimum:
	// pay__bot next to pay_bot is confusing and must be rejected.
	if len(base) < 2 || strings.Contains(base, "__") || strings.HasSuffix(base, "_") ||
		!botBaseRE.MatchString(base) {

		return "", false
	}
	return username, true
}

func hashBotToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newBotToken() (string, string, string) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("crypto/rand failed")
	}
	plain := "fcb_" + base64.RawURLEncoding.EncodeToString(raw)
	return plain, hashBotToken(plain), plain[:12]
}

type CreatedBot struct {
	Bot      *model.Bot
	User     *model.User
	Username string
	Token    string
}

// CreateBot creates the bot user row and its bot profile. The caller (root
// bot or management endpoint) is the owner; the plaintext token is returned
// once and is never stored.
func (s *Service) CreateBot(ctx context.Context, ownerID, username, displayName string) (*CreatedBot, error) {
	if ownerID == "" {
		return nil, ErrBotOwnerRequired
	}
	username, ok := ParseBotUsername(username)
	if !ok {
		return nil, ErrBotUsernameInvalid
	}
	if username == MasterBotUsername || username == legacyMasterBotUsername {
		return nil, ErrBotUsernameReserved
	}
	if _, ok := s.store.GetUserByID(ctx, ownerID); !ok {
		return nil, ErrUserNotFound
	}
	if s.store.CountBotsByOwner(ctx, ownerID) >= MaxBotsPerOwner {
		return nil, ErrBotQuotaExceeded
	}
	if _, ok := s.store.GetUserByID(ctx, username+":"+s.ServerDomain()); ok {
		return nil, ErrBotUsernameTaken
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = username
	}
	if utf8.RuneCountInString(displayName) > maxBotDisplayNameRunes {
		return nil, ErrBotDisplayNameInvalid
	}
	userID := username + ":" + s.ServerDomain()
	user := &model.User{
		ID:          userID,
		Email:       "bot+" + userID + "@bots.local",
		Username:    username,
		DisplayName: displayName,
		IsBot:       true,
	}
	token, hash, prefix := newBotToken()
	bot := &model.Bot{
		UserID: userID, OwnerID: ownerID,
		TokenHash: hash, TokenPrefix: prefix,
		EncryptionMode: EncryptionModeServer, IsActive: true,
	}
	// One transaction: a failure between the two inserts must not leave a
	// bot-shaped users row that occupies the username forever.
	if err := s.store.CreateBotAccount(ctx, user, bot); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, ErrBotUsernameTaken
		}
		// A database or CSPRNG failure is not "the username is taken": keep
		// the real cause instead of sending the user to pick another name.
		return nil, err
	}
	return &CreatedBot{Bot: bot, User: user, Username: username, Token: token}, nil
}

// GetBotByToken resolves a Bot API bearer token.
func (s *Service) GetBotByToken(ctx context.Context, token string) (*model.Bot, *model.User, bool) {
	bot, ok := s.store.GetBotByTokenHash(ctx, hashBotToken(token))
	if !ok {
		return nil, nil, false
	}
	user, ok := s.store.GetUserByID(ctx, bot.UserID)
	if !ok || !user.IsBot || !bot.IsActive {
		return nil, nil, false
	}
	// A banned owner must not regain Bot API access just because an admin
	// later re-enables the bot.
	if owner, ok := s.store.GetUserByID(ctx, bot.OwnerID); !ok || owner.Banned {
		return nil, nil, false
	}
	return bot, user, true
}

// OpenBotChat creates or returns the 1-1 chat between a user and a bot.
func (s *Service) OpenBotChat(ctx context.Context, userID, username string) (ChatView, error) {
	username, ok := ParseBotUsername(username)
	if !ok {
		return ChatView{}, ErrBotUsernameInvalid
	}
	botUser, ok := s.store.GetUserByID(ctx, username+":"+s.ServerDomain())
	if !ok || !botUser.IsBot {
		return ChatView{}, ErrUserNotFound
	}
	if userID == botUser.ID {
		return ChatView{}, ErrBotSelfChat
	}
	bot, ok := s.store.GetBot(ctx, botUser.ID)
	if !ok || !bot.IsActive {
		return ChatView{}, ErrBotNotActive
	}
	if bc, ok := s.store.GetBotChat(ctx, botUser.ID, userID); ok {
		chat, ok := s.store.GetChat(ctx, bc.ChatID)
		if ok {
			if err := s.store.ClearChatDeletes(ctx, chat.ID, userID); err != nil {
				return ChatView{}, err
			}
			return s.EnrichChat(ctx, chat), nil
		}
	}
	chat, err := s.store.CreateChat(ctx, userID, botUser.ID, "")
	if err != nil {
		return ChatView{}, err
	}
	if err := s.store.SetChatBot(ctx, chat.ID, botUser.ID, bot.EncryptionMode); err != nil {
		return ChatView{}, err
	}
	if err := s.store.CreateBotChat(ctx, botUser.ID, userID, chat.ID); err != nil {
		return ChatView{}, err
	}
	chat.BotID = botUser.ID
	view := s.EnrichChat(ctx, chat)
	s.sendEvent(userID, sse.Event{Event: eventChatCreated, Data: view})
	return view, nil
}

func (s *Service) PruneBotData(ctx context.Context) error {
	return s.store.PruneBotData(ctx, time.Now().UTC().Add(-7*24*time.Hour))
}

// PollBotUpdates implements long polling. A small DB poll is enough for the
// single-process SQLite deployment; a notifier can replace it later.
func (s *Service) PollBotUpdates(ctx context.Context, botID string, offset uint64, limit int, timeout time.Duration) ([]model.BotUpdate, error) {
	s.pruneBotDataOnce(ctx)
	if offset > 0 {
		if err := s.store.DeleteBotUpdatesBefore(ctx, botID, offset); err != nil {
			log().Warn("failed to acknowledge bot updates", "botID", botID, "offset", offset, "err", err)
		}
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	if timeout > MaxBotPollTimeout {
		timeout = MaxBotPollTimeout
	}
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(botPollInterval)
	defer ticker.Stop()

	for {
		updates, err := s.store.GetBotUpdates(ctx, botID, offset, limit)
		if err != nil {
			return nil, err
		}
		if len(updates) > 0 || timeout <= 0 || time.Now().After(deadline) {
			return updates, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Service) SetBotEncryptionKey(ctx context.Context, botID, publicKey, identityPublicKey string) error {
	// Bots cannot rotate their key (checked below), so the version they are
	// expected to be at and the version written are always the same. The
	// store keeps both parameters for the account path, where they differ.
	expectedVersion := 1
	if user, ok := s.store.GetUserByID(ctx, botID); ok {
		if user.KeyVersion >= 1 {
			expectedVersion = user.KeyVersion
		}
	}
	if bot, ok := s.store.GetBot(ctx, botID); ok && bot.EncryptionMode == EncryptionModeE2EE {
		user, _ := s.store.GetUserByID(ctx, botID)
		if user != nil && user.IdentityPublicKey != "" {
			if user.IdentityPublicKey != identityPublicKey {
				// Re-enabling with a different identity would make every
				// client that pinned the old key reject the bot's messages.
				return ErrBotKeysAlreadySet
			}
			if user.PublicKey == publicKey {
				// A retried request with the exact same keys is not a
				// rotation and must not inflate key_version.
				return nil
			}
			// Bots have no key history: rotating the encryption key would
			// make messages encrypted before recipients refresh their cached
			// pubkey permanently unreadable.
			return ErrBotKeysAlreadySet
		}
	}
	if err := s.store.SetBotEncryptionKey(
		ctx,
		botID,
		publicKey,
		identityPublicKey,
		expectedVersion,
		expectedVersion,
	); err != nil {
		if errors.Is(err, store.ErrBotIdentityConflict) {
			return ErrBotKeysAlreadySet
		}
		return err
	}
	chatIDs, err := s.store.ChatIDsByBotID(ctx, botID)
	if err != nil {
		return err
	}
	for _, chatID := range chatIDs {
		chat, ok := s.store.GetChat(ctx, chatID)
		if !ok {
			continue
		}
		view := s.EnrichChat(ctx, chat)
		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: view})
		}
	}
	return nil
}

// SendBotMessage stores a plaintext bot message and pushes it to the human
// participant when offline.
func (s *Service) SendBotMessage(ctx context.Context, botID, chatID, text string, markup *model.InlineKeyboardMarkup) (*model.Message, error) {
	return s.sendBotMessage(ctx, botID, chatID, text, markup, false, "", nil, nil, "")
}

// SendBotEncryptedMessageWithID uses the client-generated message id, so the
// bot can bind its signature and AAD to the same id the server stores.
func (s *Service) SendBotEncryptedMessageWithID(
	ctx context.Context, botID, chatID, messageID, ciphertext, payload string,
) (*model.Message, error) {

	return s.sendBotMessage(ctx, botID, chatID, ciphertext, nil, true, payload, nil, nil, messageID)
}

func (s *Service) SendBotEncryptedMessageWithFilesID(
	ctx context.Context, botID, chatID, messageID, ciphertext, payload string, fileIDs []string,
) (*model.Message, error) {

	return s.sendBotMessage(ctx, botID, chatID, ciphertext, nil, true, payload, fileIDs, nil, messageID)
}

// SendBotMessageWithFiles attaches already-uploaded files to a bot message.
func (s *Service) SendBotMessageWithFiles(
	ctx context.Context, botID, chatID, text string,
	markup *model.InlineKeyboardMarkup, fileIDs []string,
	encrypted bool, payload string, location *model.Location,
) (*model.Message, error) {

	return s.sendBotMessage(ctx, botID, chatID, text, markup, encrypted, payload, fileIDs, location, "")
}

func (s *Service) SendBotFile(ctx context.Context, botID, chatID, fileID, caption string) (*model.Message, error) {
	return s.sendBotMessage(ctx, botID, chatID, caption, nil, false, "", []string{fileID}, nil, "")
}

func (s *Service) SendBotLocation(ctx context.Context, botID, chatID string, lat, lng float64) (*model.Message, error) {
	if !ValidCoords(lat, lng) {
		return nil, ErrInvalidCoordinates
	}
	return s.sendBotMessage(ctx, botID, chatID, "", nil, false, "", nil, &model.Location{Lat: lat, Lng: lng}, "")
}

type federationEnqueuer interface {
	Post(ctx context.Context, remoteServer, path string, body any)
	Patch(ctx context.Context, remoteServer, path string, body any)
	Delete(ctx context.Context, remoteServer, path string)
}

func (s *Service) queueFederation(ctx context.Context, remoteServer, method, path string, body any) {
	// The outbox INSERT must survive a dropped client connection: the
	// operation is the durable half of the delivery guarantee.
	ctx = context.WithoutCancel(ctx)
	if fed, ok := s.fed.(federationEnqueuer); ok {
		switch method {
		case "POST":
			fed.Post(ctx, remoteServer, path, body)
		case "PATCH":
			fed.Patch(ctx, remoteServer, path, body)
		case "DELETE":
			fed.Delete(ctx, remoteServer, path)
		}
		return
	}
	if s.fed == nil {
		return
	}
	if _, err := s.fed.Request(ctx, method, s.fed.URL(remoteServer, path), body); err != nil {
		log().Warn("federated bot message failed", "err", err)
	}
}

//nolint:gocyclo,gocognit,cyclop // attachments, markup, push and federation share one send path.
func (s *Service) sendBotMessage(
	ctx context.Context,
	botID, chatID, text string,
	markup *model.InlineKeyboardMarkup,
	encrypted bool,
	payload string,
	fileIDs []string,
	location *model.Location,
	messageID string,
) (*model.Message, error) {

	bot, ok := s.store.GetBot(ctx, botID)
	if !ok || !bot.IsActive {
		return nil, ErrBotNotActive
	}
	if chat, found := s.store.GetChat(ctx, chatID); found && chat.RemoteServer != "" && markup != nil {
		return nil, ErrBotAttachmentRemote
	}
	if bot.EncryptionMode == EncryptionModeE2EE {
		if !encrypted {
			return nil, ErrBotEncryptionRequired
		}
		if err := ValidateEncryptedPayload(true, payload); err != nil {
			return nil, err
		}
		if markup != nil || location != nil {
			return nil, ErrBotMarkupInvalid
		}
	} else if encrypted {
		return nil, ErrBotEncryptionForbidden
	}
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return nil, ErrChatNotFound
	}
	// Blocking a bot is the user's only way to stop unsolicited messages;
	// the bot path must honour it just like a private user-to-user chat.
	if s.IsBlockedBetween(ctx, botID, bc.UserID) {
		return nil, ErrUserBlocked
	}
	user, ok := s.store.GetUserByID(ctx, botID)
	if !ok {
		return nil, ErrUserNotFound
	}
	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return nil, ErrChatNotFound
	}
	text = strings.TrimSpace(text)
	maxLen := MaxMessageLen
	if encrypted {
		maxLen = EncryptedMaxLen
	}
	if utf8.RuneCountInString(text) > maxLen {
		return nil, ErrMessageTooLong
	}
	resolvedFiles := s.ResolveMessageFiles(ctx, botID, fileIDs, nil)
	if encrypted && !s.filesEncrypted(ctx, resolvedFiles) {
		return nil, ErrBotEncryptionRequired
	}
	if len(resolvedFiles) > MaxMessageFiles {
		return nil, ErrTooManyFiles
	}
	if text == "" && len(resolvedFiles) == 0 && location == nil {
		return nil, ErrEmptyMessage
	}
	if location != nil && !ValidCoords(location.Lat, location.Lng) {
		return nil, ErrInvalidCoordinates
	}
	if encrypted && location != nil {
		return nil, ErrBotMarkupInvalid
	}
	if chat.RemoteServer != "" && (location != nil || markup != nil) {
		return nil, ErrBotAttachmentRemote
	}
	if err := validateInlineKeyboard(markup); err != nil {
		return nil, err
	}
	msg, created, err := s.store.AddMessage(ctx, chatID, "", botID, user.DisplayName, text, messageID, "", location, encrypted, payload)
	if err != nil {
		return nil, err
	}
	// Attachments and markup are idempotent: a retry whose first attempt
	// inserted the row but failed to attach files/markup must repair them.
	if len(resolvedFiles) > 0 {
		if err := s.store.AddMessageFiles(ctx, msg.ID, resolvedFiles); err != nil &&
			(created || !errors.Is(err, store.ErrFileNotFound)) {

			return nil, err
		}
		files, _ := s.store.GetMessageFiles(ctx, msg.ID) //nolint:errcheck // best-effort
		msg.Files = files
	}
	// Never overwrite a markup that a later edit may have set on a replay.
	if markup != nil && created {
		if err := s.store.SetMessageReplyMarkup(ctx, msg.ID, markup); err != nil {
			return nil, err
		}
		msg.ReplyMarkup = markup
	}
	if created {
		// A bot message is still a new message: it must bring a hidden chat
		// back, otherwise the push arrives while the chat stays invisible.
		if err := s.store.ClearChatDeletes(ctx, chat.ID, bc.UserID); err != nil {
			log().Warn("failed to unhide bot chat after a message", "chat", chat.ID, "err", err)
		}
		s.sendEvent(bc.UserID, sse.Event{Event: eventNewMessage, Data: msg})
		s.SendPushForMessage(ctx, chat, msg, "", bc.UserID)
		if chat.RemoteServer != "" && s.fed != nil {
			s.queueFederation(ctx, chat.RemoteServer, "POST", "/api/federated/chats/"+chat.ID+"/messages", map[string]any{
				"id": msg.ID, "fromId": botID, "fromNick": user.DisplayName,
				keyText: msg.Text, keyEncrypted: encrypted, keyEncryptedPayload: payload, keyFiles: msg.Files,
			})
		}
	}
	return msg, nil
}

// AppendBotMessageUpdate queues a user message for the bot's getUpdates.
func (s *Service) filesEncrypted(ctx context.Context, fileIDs []string) bool {
	for _, id := range fileIDs {
		file, err := s.store.GetFile(ctx, id)
		if err != nil || !file.Encrypted {
			return false
		}
	}
	return true
}

func (s *Service) AppendBotMessageUpdate(ctx context.Context, chatID string, msg *model.Message) {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok {
		return
	}
	from := map[string]any{
		"id": msg.FromID, "username": msg.FromNick, "display_name": msg.FromNick,
		"is_bot": false,
	}
	if user, ok := s.store.GetUserByID(ctx, msg.FromID); ok {
		from["username"] = user.Username
		from["display_name"] = user.DisplayName
		from["is_bot"] = user.IsBot
	}
	payload, err := json.Marshal(map[string]any{
		"update_id": 0,
		"message": map[string]any{
			"message_id":        msg.ID,
			"chat_id":           chatID,
			keyFrom:             from,
			keyText:             msg.Text,
			keyEncrypted:        msg.Encrypted,
			"encrypted_payload": msg.EncryptedPayload,
			keyLocation:         msg.Location,
			keyFiles:            msg.Files,
			"date":              msg.CreatedAt,
		},
	})
	if err != nil {
		return
	}
	if _, err := s.store.AppendBotUpdate(ctx, bc.BotID, "message", string(payload)); err != nil {
		log().Warn("failed to append bot update", "err", err)
	}
}

func validateInlineKeyboard(markup *model.InlineKeyboardMarkup) error {
	if markup == nil {
		return nil
	}
	if len(markup.InlineKeyboard) > 8 {
		return ErrBotMarkupInvalid
	}
	for _, row := range markup.InlineKeyboard {
		if len(row) > 8 {
			return ErrBotMarkupInvalid
		}
		for _, button := range row {
			if button.Text == "" || len(button.Text) > 64 {
				return ErrBotMarkupInvalid
			}
			if button.CallbackData != "" && len(button.CallbackData) > 64 {
				return ErrBotMarkupInvalid
			}
			if button.CallbackData == "" && button.URL == "" {
				return ErrBotMarkupInvalid
			}
			if button.CallbackData != "" && button.URL != "" {
				return ErrBotMarkupInvalid
			}
			if button.URL != "" && !strings.HasPrefix(button.URL, "http://") && !strings.HasPrefix(button.URL, "https://") {
				return ErrBotMarkupInvalid
			}
		}
	}
	return nil
}

// CreateBotCallback records a button press and queues a callback_query update.
func (s *Service) CreateBotCallback(ctx context.Context, userID, chatID, messageID, data string) (*model.BotCallbackQuery, error) {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.UserID != userID {
		return nil, ErrChatNotFound
	}
	msg, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil || msg.FromID != bc.BotID {
		return nil, ErrMessageNotFound
	}
	if data == "" {
		return nil, ErrBotMarkupInvalid
	}
	if msg.Encrypted {
		// The markup lives inside the encrypted payload, so the server
		// cannot validate it; the bot validates the decrypted data.
		if len(data) > 256 || !strings.HasPrefix(data, "fcbenc:") {
			return nil, ErrBotMarkupInvalid
		}
	} else {
		if len(data) > 64 {
			return nil, ErrBotMarkupInvalid
		}
		valid := false
		if msg.ReplyMarkup != nil {
			for _, row := range msg.ReplyMarkup.InlineKeyboard {
				for _, button := range row {
					if button.CallbackData == data {
						valid = true
					}
				}
			}
		}
		if !valid {
			return nil, ErrBotMarkupInvalid
		}
	}
	query := &model.BotCallbackQuery{
		ID: ids.Generate(), BotID: bc.BotID, ChatID: chatID,
		MessageID: messageID, UserID: userID, Data: data, CreatedAt: time.Now().UTC(),
	}
	// The root bot has no external polling client, so its buttons are
	// handled in-process; queueing the update would leave it unanswered
	// forever.
	if s.isMasterBot(ctx, bc.BotID) {
		if bot, ok := s.store.GetBot(ctx, bc.BotID); !ok || !bot.IsActive {
			return nil, ErrBotNotActive
		}
		// Persist the query so the returned id is truthful for clients that
		// later answer it; it is not queued in bot_updates because the root
		// bot has no poller.
		if err := s.store.CreateBotCallbackQuery(ctx, query); err != nil {
			return nil, err
		}
		if err := s.HandleRootBotCallback(ctx, chatID, userID, data); err != nil {
			return nil, err
		}

		return query, nil
	}
	user, _ := s.store.GetUserByID(ctx, userID)
	if err := s.store.CreateBotCallbackQuery(ctx, query); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(map[string]any{
		"update_id": 0,
		"callback_query": map[string]any{
			"id": query.ID, "chat_id": chatID, "message_id": messageID, "data": data,
			"from": map[string]any{"id": userID, "username": user.Username, "display_name": user.DisplayName},
		},
	})
	if err != nil {
		return nil, err
	}
	if _, err := s.store.AppendBotUpdate(ctx, bc.BotID, "callback_query", string(payload)); err != nil {
		return nil, err
	}
	return query, nil
}

// AnswerBotCallback records the bot's answer; v1 does not push it to the UI.
func (s *Service) AnswerBotCallback(
	ctx context.Context,
	botID, callbackID, text string,
	showAlert, encrypted bool,
	payload string,
) error {

	query, ok := s.store.GetBotCallbackQuery(ctx, callbackID, botID)
	if !ok {
		return ErrMessageNotFound
	}
	// The user may have blocked the bot after pressing the button: the answer
	// travels to that user over SSE, so the block applies here as well.
	if s.IsBlockedBetween(ctx, botID, query.UserID) {
		return ErrUserBlocked
	}
	if utf8.RuneCountInString(text) > maxBotCallbackAnswerRunes {
		return ErrBotAnswerTooLong
	}
	bot, ok := s.store.GetBot(ctx, botID)
	if !ok || !bot.IsActive {
		return ErrBotNotActive
	}
	if bot.EncryptionMode == EncryptionModeE2EE {
		if text != "" && !encrypted {
			return ErrBotEncryptionRequired
		}
		if encrypted {
			if err := ValidateEncryptedPayload(true, payload); err != nil {
				return err
			}
		}
	} else if encrypted {
		return ErrBotEncryptionForbidden
	}
	if err := s.store.AnswerBotCallbackQuery(ctx, callbackID, botID, text, showAlert); err != nil {
		return err
	}
	s.sendEvent(query.UserID, sse.Event{Event: eventBotCallbackAnswer, Data: map[string]any{
		"callbackQueryId":  callbackID,
		"text":             text,
		"showAlert":        showAlert,
		"encrypted":        encrypted,
		"encryptedPayload": payload,
		"botId":            query.BotID,
		keyChatID:          query.ChatID,
		"messageId":        query.MessageID,
	}})
	return nil
}

func (s *Service) RotateBotToken(ctx context.Context, ownerID, username string) (string, error) {
	username, ok := ParseBotUsername(username)
	if !ok {
		return "", ErrBotUsernameInvalid
	}
	bot, ok := s.store.GetBot(ctx, username+":"+s.ServerDomain())
	if !ok || bot.OwnerID != ownerID {
		return "", ErrBotNotActive
	}
	token, hash, prefix := newBotToken()
	if err := s.store.UpdateBotToken(ctx, bot.UserID, hash, prefix); err != nil {
		return "", err
	}
	return token, nil
}

func (s *Service) SetBotEnabled(ctx context.Context, ownerID, username string, enabled bool) error {
	username, ok := ParseBotUsername(username)
	if !ok {
		return ErrBotUsernameInvalid
	}
	bot, ok := s.store.GetBot(ctx, username+":"+s.ServerDomain())
	if !ok || bot.OwnerID != ownerID {
		return ErrBotNotActive
	}
	return s.store.SetBotActive(ctx, bot.UserID, enabled, nil)
}

//nolint:gocyclo,cyclop // mode, markup, reply markup and federation share one edit path.
func (s *Service) EditBotMessage(
	ctx context.Context,
	botID, chatID, messageID, text string,
	markup *model.InlineKeyboardMarkup,
	encrypted bool,
	payload string,
) (*model.Message, error) {

	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return nil, ErrChatNotFound
	}
	msg, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil || msg.FromID != botID {
		return nil, ErrMessageNotFound
	}
	bot, ok := s.store.GetBot(ctx, botID)
	if !ok || !bot.IsActive {
		return nil, ErrBotNotActive
	}
	if chat, found := s.store.GetChat(ctx, chatID); found && chat.RemoteServer != "" && markup != nil {
		return nil, ErrBotAttachmentRemote
	}
	if bot.EncryptionMode == EncryptionModeE2EE {
		if !encrypted {
			return nil, ErrBotEncryptionRequired
		}
		if err := ValidateEncryptedPayload(true, payload); err != nil {
			return nil, err
		}
		if markup != nil {
			return nil, ErrBotMarkupInvalid
		}
	} else if encrypted {
		return nil, ErrBotEncryptionForbidden
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, ErrEmptyMessage
	}
	maxLen := MaxMessageLen
	if encrypted {
		maxLen = EncryptedMaxLen
	}
	if utf8.RuneCountInString(text) > maxLen {
		return nil, ErrMessageTooLong
	}
	if err := validateInlineKeyboard(markup); err != nil {
		return nil, err
	}
	if !encrypted {
		payload = ""
	}
	if err := s.store.EditRawMessage(ctx, chatID, messageID, text, time.Now().UTC(), nil, false, &encrypted, &payload); err != nil {
		return nil, err
	}
	if err := s.store.SetMessageReplyMarkup(ctx, messageID, markup); err != nil {
		return nil, err
	}
	updated, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil {
		return nil, err
	}
	s.sendEvent(bc.UserID, sse.Event{Event: eventMessageUpdated, Data: updated})
	if chat, ok := s.store.GetChat(ctx, chatID); ok && chat.RemoteServer != "" && s.fed != nil {
		s.queueFederation(ctx, chat.RemoteServer, "PATCH", "/api/federated/chats/"+chatID+"/messages/"+messageID, map[string]any{
			"text": text, keyEncrypted: encrypted, keyEncryptedPayload: payload,
		})
	}
	return &updated, nil
}

func (s *Service) DeleteBotMessage(ctx context.Context, botID, chatID, messageID string) error {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return ErrChatNotFound
	}
	msg, err := s.store.GetMessage(ctx, chatID, messageID)
	if err != nil || msg.FromID != botID {
		return ErrMessageNotFound
	}
	if err := s.store.DeleteRawMessage(ctx, chatID, messageID); err != nil {
		return err
	}
	s.sendEvent(bc.UserID, sse.Event{Event: eventMessageDeleted, Data: map[string]string{keyChatID: chatID, keyMessageID: messageID}})
	if chat, ok := s.store.GetChat(ctx, chatID); ok && chat.RemoteServer != "" && s.fed != nil {
		s.queueFederation(ctx, chat.RemoteServer, "DELETE", "/api/federated/chats/"+chatID+"/messages/"+messageID, nil)
	}
	return nil
}

type BotManagedView struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName,omitempty"`
	IsActive    bool   `json:"isActive"`
	IsMaster    bool   `json:"isMaster"`
}

func (s *Service) ListOwnedBots(ctx context.Context, ownerID string) ([]BotManagedView, error) {
	bots, err := s.store.ListBotsByOwner(ctx, ownerID)
	if err != nil {
		return nil, err
	}
	out := make([]BotManagedView, 0, len(bots))
	for idx := range bots {
		user, ok := s.store.GetUserByID(ctx, bots[idx].UserID)
		if !ok {
			continue
		}
		out = append(out, BotManagedView{
			ID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
			IsActive: bots[idx].IsActive, IsMaster: bots[idx].IsMaster,
		})
	}
	return out, nil
}

type DeviceKey struct {
	ID         string `json:"id"`
	PublicKey  string `json:"publicKey"`
	KeyVersion int    `json:"keyVersion"`
}

// ListUserDeviceKeys returns the account's master key. The name is kept for
// the Bot API shape; v3 keys messages to the account, not to a device.
func (s *Service) ListUserDeviceKeys(ctx context.Context, userID string) ([]DeviceKey, error) {
	remote := RemoteServerFromIDFor(userID, s.cfg.Federation.AllowPrivateAddresses)
	if remote != "" && remote != s.cfg.Server.Domain {
		if s.fed == nil {
			return nil, ErrUserNotFound
		}
		data, err := s.fed.Request(ctx, "GET", s.fed.URL(remote, "/api/federated/users/"+url.PathEscape(userID)+"/public-key"), nil)
		if err != nil {
			var statusErr *federation.StatusError
			if errors.As(err, &statusErr) && statusErr.Status == 404 {
				return nil, ErrUserNotFound
			}
			return nil, err
		}
		var result struct {
			PublicKey        string `json:"publicKey"`
			MasterKeyVersion int    `json:"masterKeyVersion"`
		}
		if err := json.Unmarshal(data, &result); err != nil || result.PublicKey == "" {
			return nil, ErrUserNotFound
		}
		if _, err := DecodePublicKey(result.PublicKey); err != nil {
			return nil, ErrUserNotFound
		}
		if result.MasterKeyVersion < 1 {
			result.MasterKeyVersion = 1
		}
		return []DeviceKey{{
			ID: userID, PublicKey: result.PublicKey, KeyVersion: result.MasterKeyVersion,
		}}, nil
	}

	publicKey, _, version, ok := s.store.GetUserMasterKey(ctx, userID)
	if !ok {
		return nil, ErrUserNotFound
	}
	return []DeviceKey{{ID: userID, PublicKey: publicKey, KeyVersion: version}}, nil
}

// FetchFederatedFile returns the bytes of a remote file placeholder through
// the signed federation client.
func (s *Service) FetchFederatedFile(ctx context.Context, fileID string) ([]byte, *model.File, error) {
	file, err := s.store.GetFile(ctx, fileID)
	if err != nil {
		return nil, nil, err
	}
	if file.RemoteServer == "" {
		return nil, file, nil
	}
	if s.fed == nil {
		return nil, nil, ErrFileNotFound
	}
	body, err := s.fed.Request(ctx, "GET", s.fed.URL(file.RemoteServer, "/api/federated/files/"+url.PathEscape(fileID)), nil)
	if err != nil {
		return nil, nil, err
	}
	return body, file, nil
}

func (s *Service) GetBotChatForUser(ctx context.Context, botID, userID string) (*model.BotChat, bool) {
	return s.store.GetBotChat(ctx, botID, userID)
}

type BotChatInfo struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

func (s *Service) GetBotChat(ctx context.Context, botID, chatID string) (BotChatInfo, error) {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return BotChatInfo{}, ErrChatNotFound
	}
	user, ok := s.store.GetUserByID(ctx, bc.UserID)
	if !ok {
		return BotChatInfo{}, ErrUserNotFound
	}
	return BotChatInfo{
		ID: chatID, Type: callChatTypePrivate, Username: user.Username, DisplayName: user.DisplayName,
	}, nil
}

func (s *Service) BotChatAction(ctx context.Context, botID, chatID, action string) error {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return ErrChatNotFound
	}
	// A blocked bot must not keep sending typing events either: they reach
	// the user over the same hub as messages.
	if s.IsBlockedBetween(ctx, botID, bc.UserID) {
		return ErrUserBlocked
	}
	if action != "typing" {
		return ErrBotActionInvalid
	}
	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}
	user, ok := s.store.GetUserByID(ctx, botID)
	if !ok {
		return ErrUserNotFound
	}
	s.HandleTyping(ctx, chat, chatID, botID, user.DisplayName, true)
	return nil
}

func (s *Service) pruneBotDataOnce(ctx context.Context) {
	s.botPruneMu.Lock()
	defer s.botPruneMu.Unlock()
	if time.Since(s.lastBotPrune) < time.Hour {
		return
	}
	s.lastBotPrune = time.Now()
	if err := s.PruneBotData(ctx); err != nil {
		log().Warn("bot data prune failed", "err", err)
	}
}
