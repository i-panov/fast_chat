package store

import (
	"context"

	"fast_chat/model"
)

// CreateBotUser inserts the synthetic user row that represents a bot. It has
// no session and cannot log in through the normal auth flow.
func (s *Store) CreateBotUser(ctx context.Context, user *model.User) error {
	return s.db.WithContext(ctx).Create(user).Error
}

func (s *Store) SetChatBotID(ctx context.Context, chatID, botID string) error {
	return s.db.WithContext(ctx).Model(&model.Chat{}).
		Where("id = ?", chatID).Update("bot_id", botID).Error
}

func (s *Store) GetChatBotID(ctx context.Context, chatID string) (string, bool) {
	var botID string
	if err := s.db.WithContext(ctx).Model(&model.Chat{}).
		Select("bot_id").Where("id = ?", chatID).Scan(&botID).Error; err != nil || botID == "" {
		return "", false
	}
	return botID, true
}
