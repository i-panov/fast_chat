package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"fast_chat/internal/ids"
	"fast_chat/model"
	"fast_chat/sse"
)

const (
	keyFrom             = "from"
	keyText             = "text"
	keyEncrypted        = "encrypted"
	keyEncryptedPayload = "encryptedPayload"
)

var (
	ErrBotUsernameInvalid = errors.New("bot username must match the username rules and end with _bot")
	ErrBotUsernameTaken   = errors.New("bot username taken")
	ErrBotOwnerRequired   = errors.New("bot owner is required")
	ErrBotNotActive       = errors.New("bot is not active")
	ErrBotSelfChat        = errors.New("cannot open a bot chat with a bot")
	ErrBotMarkupInvalid   = errors.New("invalid inline keyboard")
	ErrBotActionInvalid   = errors.New("unsupported bot action")
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
	if len(base) < 2 || !botBaseRE.MatchString(base) {
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
	if _, ok := s.store.GetUserByID(ctx, ownerID); !ok {
		return nil, ErrUserNotFound
	}
	if _, ok := s.store.GetUserByID(ctx, username+":"+s.ServerDomain()); ok {
		return nil, ErrBotUsernameTaken
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = username
	}
	userID := username + ":" + s.ServerDomain()
	user := &model.User{
		ID:          userID,
		Email:       "bot+" + userID + "@bots.local",
		Username:    username,
		DisplayName: displayName,
		IsBot:       true,
	}
	if err := s.store.CreateBotUser(ctx, user); err != nil {
		return nil, ErrBotUsernameTaken
	}
	token, hash, prefix := newBotToken()
	bot := &model.Bot{
		UserID: userID, OwnerID: ownerID,
		TokenHash: hash, TokenPrefix: prefix,
		EncryptionMode: "server", IsActive: true,
	}
	if err := s.store.CreateBot(ctx, bot, nil); err != nil {
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
			return s.EnrichChat(ctx, chat), nil
		}
	}
	chat, err := s.store.CreateChat(ctx, userID, botUser.ID, "")
	if err != nil {
		return ChatView{}, err
	}
	if err := s.store.SetChatBotID(ctx, chat.ID, botUser.ID); err != nil {
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
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	deadline := time.Now().Add(timeout)
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
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *Service) SetBotEncryptionKey(ctx context.Context, botID, publicKey string) error {
	return s.store.SetBotEncryptionKey(ctx, botID, publicKey)
}

// SendBotMessage stores a plaintext bot message and pushes it to the human
// participant when offline.
func (s *Service) SendBotMessage(ctx context.Context, botID, chatID, text string, markup *model.InlineKeyboardMarkup) (*model.Message, error) {
	return s.sendBotMessage(ctx, botID, chatID, text, markup, false, "")
}

func (s *Service) SendBotEncryptedMessage(ctx context.Context, botID, chatID, ciphertext, payload string) (*model.Message, error) {
	return s.sendBotMessage(ctx, botID, chatID, ciphertext, nil, true, payload)
}

func (s *Service) sendBotMessage(
	ctx context.Context,
	botID, chatID, text string,
	markup *model.InlineKeyboardMarkup,
	encrypted bool,
	payload string,
) (*model.Message, error) {

	bot, ok := s.store.GetBot(ctx, botID)
	if !ok || !bot.IsActive {
		return nil, ErrBotNotActive
	}
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return nil, ErrChatNotFound
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
	if text == "" {
		return nil, ErrEmptyMessage
	}
	if err := validateInlineKeyboard(markup); err != nil {
		return nil, err
	}
	msg, created, err := s.store.AddMessage(ctx, chatID, "", botID, user.DisplayName, text, "", "", nil, encrypted, payload)
	if err != nil {
		return nil, err
	}
	if created {
		if markup != nil {
			if err := s.store.SetMessageReplyMarkup(ctx, msg.ID, markup); err != nil {
				return nil, err
			}
			msg.ReplyMarkup = markup
		}
		s.sendEvent(bc.UserID, sse.Event{Event: eventNewMessage, Data: msg})
		s.SendPushForMessage(ctx, chat, msg, "", bc.UserID)
		if chat.RemoteServer != "" && s.fed != nil {
			groupURL := s.fed.URL(chat.RemoteServer, "/api/federated/chats/"+chat.ID+"/messages")
			if _, err := s.fed.Request(ctx, "POST", groupURL, map[string]any{
				"id": msg.ID, "fromId": botID, "fromNick": user.DisplayName,
				"text": msg.Text, keyEncrypted: encrypted, keyEncryptedPayload: payload,
			}); err != nil {
				log().Warn("federated bot reply failed", "err", err)
			}
		}
	}
	return msg, nil
}

// AppendBotMessageUpdate queues a user message for the bot's getUpdates.
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
	user, _ := s.store.GetUserByID(ctx, userID)
	query := &model.BotCallbackQuery{
		ID: ids.Generate(), BotID: bc.BotID, ChatID: chatID,
		MessageID: messageID, UserID: userID, Data: data, CreatedAt: time.Now().UTC(),
	}
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
	if err := s.store.AnswerBotCallbackQuery(ctx, callbackID, botID, text, showAlert); err != nil {
		return err
	}
	s.sendEvent(query.UserID, sse.Event{Event: eventBotCallbackAnswer, Data: map[string]any{
		"callbackQueryId":  callbackID,
		"text":             text,
		"showAlert":        showAlert,
		"encrypted":        encrypted,
		"encryptedPayload": payload,
	}})
	return nil
}

func (s *Service) RotateBotToken(ctx context.Context, ownerID, username string) (string, error) {
	username, ok := ParseBotUsername(username)
	if !ok {
		return "", ErrBotUsernameInvalid
	}
	bot, ok := s.store.GetBot(ctx, username+":"+s.ServerDomain())
	if !ok || bot.OwnerID != ownerID || !bot.IsActive {
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
	return s.store.SetBotActive(ctx, bot.UserID, enabled)
}

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
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, ErrEmptyMessage
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
	ID        string    `json:"id"`
	PublicKey string    `json:"publicKey"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Service) ListUserDeviceKeys(ctx context.Context, userID string) ([]DeviceKey, error) {
	devices, err := s.store.ListUserDevices(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]DeviceKey, 0, len(devices))
	for idx := range devices {
		out = append(out, DeviceKey{
			ID: devices[idx].ID, PublicKey: devices[idx].PublicKey, CreatedAt: devices[idx].CreatedAt,
		})
	}
	if len(out) == 0 {
		if key, ok := s.store.GetUserPublicKey(ctx, userID); ok && key != "" {
			out = append(out, DeviceKey{ID: userID, PublicKey: key})
		}
	}
	return out, nil
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
		ID: chatID, Type: "private", Username: user.Username, DisplayName: user.DisplayName,
	}, nil
}

func (s *Service) BotChatAction(ctx context.Context, botID, chatID, action string) error {
	bc, ok := s.store.GetBotChatByChatID(ctx, chatID)
	if !ok || bc.BotID != botID {
		return ErrChatNotFound
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
