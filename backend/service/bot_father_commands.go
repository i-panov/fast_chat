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
		bots, err := s.store.ListBotsByOwner(ctx, userID)
		if err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Не удалось получить список.")
			return true
		}
		if len(bots) == 0 {
			s.rootReply(ctx, bot.UserID, chat.ID, "У тебя пока нет ботов. /newbot")
			return true
		}
		var builder strings.Builder
		builder.WriteString("Твои боты:\n")
		for i := range bots {
			user, _ := s.store.GetUserByID(ctx, bots[i].UserID)
			status := "активен"
			if !bots[i].IsActive {
				status = "отключён"
			}
			builder.WriteString("@")
			builder.WriteString(user.Username)
			builder.WriteString(" — ")
			builder.WriteString(status)
			builder.WriteString("\n")
		}
		s.rootReply(ctx, bot.UserID, chat.ID, strings.TrimSpace(builder.String()))
		return true
	case strings.HasPrefix(lower, "/token "):
		username := botCommandArg(text)
		token, err := s.RotateBotToken(ctx, userID, username)
		if err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Не удалось выпустить токен: "+err.Error())
			return true
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "Новый токен для @"+username+" (показывается один раз):\n"+token)
		return true
	case strings.HasPrefix(lower, "/revoke "), strings.HasPrefix(lower, "/disable "):
		username := botCommandArg(text)
		if err := s.SetBotEnabled(ctx, userID, username, false); err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Не удалось отключить: "+err.Error())
			return true
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "@"+username+" отключён.")
		return true
	case strings.HasPrefix(lower, "/enable "):
		username := botCommandArg(text)
		if err := s.SetBotEnabled(ctx, userID, username, true); err != nil {
			s.rootReply(ctx, bot.UserID, chat.ID, "Не удалось включить: "+err.Error())
			return true
		}
		s.rootReply(ctx, bot.UserID, chat.ID, "@"+username+" включён.")
		return true
	}
	return false
}
