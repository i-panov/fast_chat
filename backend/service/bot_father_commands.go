package service

import (
	"context"
	"strings"

	"fast_chat/model"
)

func botCommandArg(text string) string {
	fields := strings.Fields(text)
	if len(fields) < 2 {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(fields[1]), "@")
}

// HandleRootBotManagement handles /mybots, /token, /revoke, /enable and
// /delete. /newbot stays in HandleRootBotCommand because it is stateful.
func (s *Service) HandleRootBotManagement(ctx context.Context, bot *model.Bot, chat *model.Chat, userID, text string) bool {
	lower := strings.ToLower(strings.TrimSpace(text))
	switch {
	case lower == "/mybots":
		s.rootReply(ctx, bot.UserID, chat.ID, s.rootBotsText(ctx, userID))
		return true
	case strings.HasPrefix(lower, "/token "):
		username := botCommandArg(text)
		token, err := s.RotateBotToken(ctx, userID, username)
		if err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Could not issue a token. Check that the bot exists and belongs to you.")
			return true
		}
		s.rootReplySecret(ctx, bot.UserID, chat.ID,
			"New token for @"+username+" (shown once, deleted in a minute):\n"+token)
		return true
	case strings.HasPrefix(lower, "/revoke "), strings.HasPrefix(lower, "/disable "):
		username := botCommandArg(text)
		if err := s.SetBotEnabled(ctx, userID, username, false); err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Could not disable the bot. Check the username.")
			return true
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "@"+username+" is disabled.")
		return true
	case strings.HasPrefix(lower, "/enable "):
		username := botCommandArg(text)
		if err := s.SetBotEnabled(ctx, userID, username, true); err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Could not enable the bot. Check the username.")
			return true
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "@"+username+" is enabled.")
		return true
	}
	return false
}
