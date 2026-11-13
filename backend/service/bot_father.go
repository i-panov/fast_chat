package service

import (
	"context"
	"strings"

	"fast_chat/model"
)

const MasterBotUsername = "fastchat_bot"

// EnsureMasterBot creates the built-in root bot once.
func (s *Service) EnsureMasterBot(ctx context.Context) (*model.Bot, *model.User, error) {
	userID := MasterBotUsername + ":" + s.ServerDomain()
	if user, ok := s.store.GetUserByID(ctx, userID); ok {
		if bot, ok := s.store.GetBot(ctx, userID); ok {
			return bot, user, nil
		}
	}
	user := &model.User{
		ID: userID, Email: "bot+" + userID + "@bots.local",
		Username: MasterBotUsername, DisplayName: "Fast Chat Bot", IsBot: true,
	}
	if err := s.store.CreateBotUser(ctx, user); err != nil {
		// A concurrent boot may have inserted it; re-read.
		if existing, ok := s.store.GetUserByID(ctx, userID); ok {
			if bot, ok := s.store.GetBot(ctx, userID); ok {
				return bot, existing, nil
			}
		}
		return nil, nil, err
	}
	_, hash, prefix := newBotToken()
	bot := &model.Bot{
		UserID: userID, TokenHash: hash, TokenPrefix: prefix,
		EncryptionMode: EncryptionModeServer, IsActive: true, IsMaster: true,
	}
	if err := s.store.CreateBot(ctx, bot, nil); err != nil {
		return nil, nil, err
	}
	return bot, user, nil
}

// HandleRootBotCommand processes a message sent to the master bot.
func (s *Service) HandleRootBotCommand(ctx context.Context, chat *model.Chat, msg *model.Message) {
	bot, _, err := s.EnsureMasterBot(ctx)
	if err != nil || chat.BotID != bot.UserID {
		return
	}
	text := strings.TrimSpace(msg.Text)
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "/cancel") {
		if err := s.store.DeleteBotFatherState(ctx, msg.FromID); err != nil {
			log().Warn("root bot state cleanup failed", "err", err)
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "Отменено.")
		return
	}
	if strings.HasPrefix(lower, "/newbot") {
		if err := s.store.SetBotFatherState(ctx, &model.BotFatherState{UserID: msg.FromID, Step: "newbot_display_name"}); err != nil {
			log().Warn("root bot state failed", "err", err)
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "Как назовём бота? Отправь отображаемое имя.")
		return
	}
	if s.HandleRootBotManagement(ctx, bot, chat, msg.FromID, text) {
		return
	}
	if strings.HasPrefix(lower, "/start") || strings.HasPrefix(lower, "/help") {
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Привет! Я Fast Chat Bot.\n\n/newbot — создать бота\n/cancel — отменить")
		return
	}
	state, ok := s.store.GetBotFatherState(ctx, msg.FromID)
	if !ok {
		s.rootReply(ctx, bot.UserID, chat.ID, "Неизвестная команда. /help")
		return
	}
	switch state.Step {
	case "newbot_display_name":
		if err := s.store.SetBotFatherState(ctx, &model.BotFatherState{
			UserID: msg.FromID, Step: "newbot_username", Payload: text,
		}); err != nil {
			log().Warn("root bot state failed", "err", err)
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "Теперь username. Он должен заканчиваться на _bot, например weather_bot.")
	case "newbot_username":
		created, err := s.CreateBot(ctx, msg.FromID, text, state.Payload)
		if err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Не получилось: "+err.Error())
			return
		}
		if err := s.store.DeleteBotFatherState(ctx, msg.FromID); err != nil {
			log().Warn("root bot state cleanup failed", "err", err)
		}
		s.rootReply(ctx, bot.UserID, chat.ID,
			"Бот создан: @"+created.Username+"\nТокен (показывается один раз):\n"+created.Token)
	}
}

func (s *Service) rootReply(ctx context.Context, botID, chatID, text string) {
	if _, err := s.SendBotMessage(ctx, botID, chatID, text, nil); err != nil {
		log().Warn("root bot reply failed", "err", err)
	}
}
