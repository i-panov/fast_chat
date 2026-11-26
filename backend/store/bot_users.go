package store

import (
	"context"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

// CreateBotUser inserts the synthetic user row that represents a bot. It has
// no session and cannot log in through the normal auth flow.
func (s *Store) CreateBotUser(ctx context.Context, user *model.User) error {
	return s.db.WithContext(ctx).Create(user).Error
}

// CreateBotAccount inserts the synthetic user and the bot profile in one
// transaction. Two separate inserts could leave an orphan users row (with
// is_bot=true) that permanently squats a username when the second insert
// fails.
func (s *Store) CreateBotAccount(ctx context.Context, user *model.User, bot *model.Bot) error {
	now := time.Now().UTC()
	if bot.CreatedAt.IsZero() {
		bot.CreatedAt = now
	}
	bot.UpdatedAt = now

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(user).Error; err != nil {
			return err
		}

		return tx.Create(bot).Error
	})
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

func (s *Store) SetChatBot(ctx context.Context, chatID, botID, encryptionMode string) error {
	return s.db.WithContext(ctx).Model(&model.Chat{}).
		Where("id = ?", chatID).
		Updates(map[string]any{"bot_id": botID, "bot_encryption_mode": encryptionMode}).Error
}

// ChatIDsByBotID lists chat ids where botID is the bot participant.
func (s *Store) ChatIDsByBotID(ctx context.Context, botID string) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&model.Chat{}).
		Where("bot_id = ?", botID).
		Pluck("id", &ids).Error
	return ids, err
}
