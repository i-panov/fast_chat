package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

const (
	// MasterBotUsername is the public username of the built-in bot. The old
	// name is kept for the one-time identity migration.
	MasterBotUsername       = "root_bot"
	legacyMasterBotUsername = "fastchat_bot"
	masterBotDisplayName    = "Root Bot"

	rootCallbackNewBot = "root:newbot"
	rootCallbackMyBots = "root:mybots"
	rootCallbackHelp   = "root:help"
	rootCallbackCancel = "root:cancel"

	botStatusActive   = "active"
	botStatusDisabled = "disabled"
)

func (s *Service) masterBotUserID() string {
	return MasterBotUsername + ":" + s.ServerDomain()
}

func (s *Service) isMasterBot(ctx context.Context, id string) bool {
	bot, ok := s.store.GetBot(ctx, id)
	return ok && bot.IsMaster
}

// rootMenu is the main inline keyboard of the built-in bot.
func rootMenu() *model.InlineKeyboardMarkup {
	return &model.InlineKeyboardMarkup{InlineKeyboard: [][]model.InlineKeyboardButton{
		{{Text: "Create a bot", CallbackData: rootCallbackNewBot}},
		{{Text: "My bots", CallbackData: rootCallbackMyBots}},
		{{Text: "Help", CallbackData: rootCallbackHelp}},
	}}
}

func rootCancelMenu() *model.InlineKeyboardMarkup {
	return &model.InlineKeyboardMarkup{InlineKeyboard: [][]model.InlineKeyboardButton{
		{{Text: "Cancel", CallbackData: rootCallbackCancel}},
	}}
}

// EnsureMasterBot creates the built-in root bot once and keeps it online:
// it lives in this process, so it is available for as long as the server is.
func (s *Service) EnsureMasterBot(ctx context.Context) (*model.Bot, *model.User, error) {
	userID := s.masterBotUserID()
	s.masterBotOnce.Do(func() {
		s.masterBotErr = s.store.MigrateLegacyMasterBot(
			ctx,
			legacyMasterBotUsername+":"+s.ServerDomain(),
			userID,
			MasterBotUsername,
			masterBotDisplayName,
		)
	})
	if s.masterBotErr != nil {
		return nil, nil, s.masterBotErr
	}

	if user, ok := s.store.GetUserByID(ctx, userID); ok {
		if !user.IsBot {
			return nil, nil, store.ErrMasterBotNameTaken
		}
		if bot, ok := s.store.GetBot(ctx, userID); ok {
			if !bot.IsMaster {
				return nil, nil, store.ErrMasterBotNameTaken
			}
			s.store.SetPresence(userID, true)

			return bot, user, nil
		}
		// The account exists but the bot row is missing (partial restore):
		// repair it instead of failing on the unique username.
		bot, err := s.createMasterBotRow(ctx, userID)
		if err != nil {
			return nil, nil, err
		}
		s.store.SetPresence(userID, true)

		return bot, user, nil
	}
	user := &model.User{
		ID: userID, Email: "bot+" + userID + "@bots.local",
		Username: MasterBotUsername, DisplayName: masterBotDisplayName, IsBot: true,
	}
	if err := s.store.CreateBotUser(ctx, user); err != nil {
		// A concurrent boot may have inserted it; re-read.
		if existing, ok := s.store.GetUserByID(ctx, userID); ok {
			if bot, ok := s.store.GetBot(ctx, userID); ok {
				s.store.SetPresence(userID, true)

				return bot, existing, nil
			}
		}
		return nil, nil, err
	}
	bot, err := s.createMasterBotRow(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	s.store.SetPresence(userID, true)

	return bot, user, nil
}

func (s *Service) createMasterBotRow(ctx context.Context, userID string) (*model.Bot, error) {
	_, hash, prefix := newBotToken()
	bot := &model.Bot{
		UserID: userID, TokenHash: hash, TokenPrefix: prefix,
		EncryptionMode: EncryptionModeServer, IsActive: true, IsMaster: true,
	}
	if err := s.store.CreateBot(ctx, bot, nil); err != nil {
		return nil, err
	}

	return bot, nil
}

// HandleRootBotCommand processes a message sent to the master bot.
func (s *Service) HandleRootBotCommand(ctx context.Context, chat *model.Chat, msg *model.Message) {
	// The in-process root bot does not go through the Bot API token check;
	// an admin disable must stop it as well.
	if bot, ok := s.store.GetBot(ctx, chat.BotID); !ok || !bot.IsActive {
		return
	}
	bot, _, err := s.EnsureMasterBot(ctx)
	if err != nil || chat.BotID != bot.UserID {
		return
	}
	text := strings.TrimSpace(msg.Text)
	lower := strings.ToLower(text)

	if strings.HasPrefix(lower, "/cancel") {
		s.cancelRootFlow(ctx, bot.UserID, chat.ID, msg.FromID)

		return
	}
	if strings.HasPrefix(lower, "/newbot") {
		s.startRootNewBot(ctx, bot.UserID, chat.ID, msg.FromID)

		return
	}
	if s.HandleRootBotManagement(ctx, bot, chat, msg.FromID, text) {
		return
	}
	if strings.HasPrefix(lower, "/start") {
		// A new dialog: an abandoned /newbot flow must not turn the next
		// arbitrary message into a display name.
		s.clearRootState(ctx, msg.FromID)
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Hi! I'm Root Bot. I can create bots for you and show the ones you already have.",
			rootMenu())

		return
	}
	if strings.HasPrefix(lower, "/help") {
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Hi! I'm Root Bot. I can create bots for you and show the ones you already have.",
			rootMenu())

		return
	}
	state, ok := s.store.GetBotFatherState(ctx, msg.FromID)
	if !ok {
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Unknown command. Use the buttons below.", rootMenu())

		return
	}
	switch state.Step {
	case "newbot_display_name":
		if err := s.store.SetBotFatherState(ctx, &model.BotFatherState{
			UserID: msg.FromID, Step: "newbot_username", Payload: text,
		}); err != nil {
			log().Warn("root bot state failed", "err", err)
		}
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Now the username. It must end with _bot, for example weather_bot.",
			rootCancelMenu())
	case "newbot_username":
		created, err := s.CreateBot(ctx, msg.FromID, text, state.Payload)
		if err != nil {
			// Never paste a raw database error into the chat: map the known
			// rejections to the action the user can take.
			s.rootReply(ctx, bot.UserID, chat.ID, botCreateErrorMessage(err), rootCancelMenu())

			return
		}
		s.clearRootState(ctx, msg.FromID)
		s.rootReplySecret(ctx, bot.UserID, chat.ID,
			"Bot created: @"+created.Username+"\nToken (shown once, deleted in a minute):\n"+created.Token)
	}
}

// HandleRootBotCallback runs the inline button of the built-in bot in-process:
// the root bot has no external long-polling client that could receive the
// callback update.
func (s *Service) HandleRootBotCallback(ctx context.Context, chatID, userID, data string) error {
	bot, _, err := s.EnsureMasterBot(ctx)
	if err != nil {
		return err
	}

	switch data {
	case rootCallbackNewBot:
		s.startRootNewBot(ctx, bot.UserID, chatID, userID)
	case rootCallbackMyBots:
		s.rootReply(ctx, bot.UserID, chatID, s.rootBotsText(ctx, userID), rootMenu())
	case rootCallbackHelp:
		s.rootReply(ctx, bot.UserID, chatID,
			"Hi! I'm Root Bot. I can create bots for you and show the ones you already have.",
			rootMenu())
	case rootCallbackCancel:
		s.cancelRootFlow(ctx, bot.UserID, chatID, userID)
	default:
		s.rootReply(ctx, bot.UserID, chatID,
			"Unknown action. Use the buttons below.", rootMenu())
	}

	return nil
}

func (s *Service) startRootNewBot(ctx context.Context, botID, chatID, userID string) {
	if err := s.store.SetBotFatherState(ctx, &model.BotFatherState{
		UserID: userID, Step: "newbot_display_name",
	}); err != nil {
		log().Warn("root bot state failed", "err", err)
	}
	s.rootReply(ctx, botID, chatID,
		"What should the bot be called? Send the display name.", rootCancelMenu())
}

func (s *Service) cancelRootFlow(ctx context.Context, botID, chatID, userID string) {
	if _, exists := s.store.GetBotFatherState(ctx, userID); !exists {
		s.rootReply(ctx, botID, chatID,
			"Nothing to cancel. Use the buttons below.", rootMenu())

		return
	}
	s.clearRootState(ctx, userID)
	s.rootReply(ctx, botID, chatID, "Cancelled.", rootMenu())
}

func (s *Service) clearRootState(ctx context.Context, userID string) {
	if err := s.store.DeleteBotFatherState(ctx, userID); err != nil {
		log().Warn("root bot state cleanup failed", "err", err)
	}
}

func (s *Service) rootBotsText(ctx context.Context, userID string) string {
	bots, err := s.store.ListBotsByOwner(ctx, userID)
	if err != nil {
		return "Could not load your bots."
	}
	if len(bots) == 0 {
		return "You have no bots yet. Use Create a bot."
	}

	var builder strings.Builder
	builder.WriteString("Your bots:\n")
	for idx := range bots {
		user, ok := s.store.GetUserByID(ctx, bots[idx].UserID)
		if !ok {
			continue
		}
		status := botStatusActive
		if !bots[idx].IsActive {
			status = botStatusDisabled
		}
		builder.WriteString("@")
		builder.WriteString(user.Username)
		builder.WriteString(" — ")
		builder.WriteString(status)
		builder.WriteString("\n")
	}

	return strings.TrimSpace(builder.String())
}

// botCreateErrorMessage turns a CreateBot rejection into a sentence the user
// can act on. Raw errors (database, driver) never reach the chat.
func botCreateErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrBotUsernameInvalid):
		return "That username is not valid. It must end with _bot, for example weather_bot."
	case errors.Is(err, ErrBotUsernameTaken):
		return "That username is already taken. Try another one."
	case errors.Is(err, ErrBotUsernameReserved):
		return "That username is reserved."
	case errors.Is(err, ErrBotQuotaExceeded):
		return "You have reached the bot limit. Delete or reuse an existing bot."
	case errors.Is(err, ErrBotDisplayNameInvalid):
		return "That display name is too long."
	case errors.Is(err, ErrUserNotFound):
		return "Your account could not be found."
	default:
		return "Could not create the bot. Try again later."
	}
}

func (s *Service) rootReply(ctx context.Context, botID, chatID, text string, markups ...*model.InlineKeyboardMarkup) {
	var markup *model.InlineKeyboardMarkup
	if len(markups) > 0 {
		markup = markups[0]
	}
	if _, err := s.SendBotMessage(ctx, botID, chatID, text, markup); err != nil {
		log().Warn("root bot reply failed", "err", err)
	}
}

// oneTimeTokenTTL controls how long a one-time bot token stays in the chat
// history. It is a variable so tests do not have to wait a minute.
var oneTimeTokenTTL = time.Minute

// rootReplySecret sends a one-time secret (a bot token) and deletes the
// message after oneTimeTokenTTL. The bot profile stores only the token hash;
// a plaintext token in the chat history would otherwise leak through every
// backup, every database dump and every synced device.
func (s *Service) rootReplySecret(ctx context.Context, botID, chatID, text string) {
	msg, err := s.SendBotMessage(ctx, botID, chatID, text, rootMenu())
	if err != nil {
		log().Warn("root bot reply failed", "err", err)

		return
	}

	// The timer outlives the request, so the request cancellation must not
	// abort the deletion; the background work keeps its own deadline. The TTL
	// is captured here, not read inside the goroutine: a test that shortens it
	// must not race with a timer of an earlier message.
	go s.expireRootSecret(context.WithoutCancel(ctx), chatID, msg.ID, oneTimeTokenTTL)
}

func (s *Service) expireRootSecret(ctx context.Context, chatID, messageID string, ttl time.Duration) {
	timer := time.NewTimer(ttl)
	defer timer.Stop()

	<-timer.C

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := s.store.DeleteRawMessage(ctx, chatID, messageID); err != nil {
		if !errors.Is(err, store.ErrMessageNotFound) {
			log().Warn("failed to expire a one-time bot token message", "chatID", chatID, "err", err)
		}

		return
	}

	if chat, ok := s.store.GetChat(ctx, chatID); ok {
		for _, memberID := range chat.Members {
			s.sendEvent(memberID, sse.Event{Event: eventMessageDeleted, Data: map[string]string{
				keyChatID: chatID, keyMessageID: messageID,
			}})
		}
	}
}
