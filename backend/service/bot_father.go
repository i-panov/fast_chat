package service

import (
	"context"
	"strings"

	"fast_chat/model"
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
	if strings.HasPrefix(lower, "/start") || strings.HasPrefix(lower, "/help") {
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
			s.rootReply(ctx, bot.UserID, chat.ID, "Could not create the bot: "+err.Error(), rootCancelMenu())

			return
		}
		s.clearRootState(ctx, msg.FromID)
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Bot created: @"+created.Username+"\nToken (shown once):\n"+created.Token,
			rootMenu())
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

func (s *Service) rootReply(ctx context.Context, botID, chatID, text string, markups ...*model.InlineKeyboardMarkup) {
	var markup *model.InlineKeyboardMarkup
	if len(markups) > 0 {
		markup = markups[0]
	}
	if _, err := s.SendBotMessage(ctx, botID, chatID, text, markup); err != nil {
		log().Warn("root bot reply failed", "err", err)
	}
}
