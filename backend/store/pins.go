package store

import (
	"context"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

func (s *Store) PinMessage(ctx context.Context, chatID, messageID, userID string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).
		Create(&model.ChatPin{
			ChatID:    chatID,
			MessageID: messageID,
			PinnedBy:  userID,
		}).Error
}

func (s *Store) UnpinMessage(ctx context.Context, chatID, messageID string) error {
	return s.db.WithContext(ctx).
		Where("chat_id = ? AND message_id = ?", chatID, messageID).
		Delete(&model.ChatPin{}).Error
}

func (s *Store) GetPinnedMessageIDs(ctx context.Context, chatID string) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&model.ChatPin{}).
		Where("chat_id = ?", chatID).
		Order("created_at DESC").
		Pluck("message_id", &ids).Error
	return ids, err
}

// GetPinnedMessages returns the pinned messages newest pin first. Missing
// messages (deleted rows that raced the pin cleanup) are skipped.
func (s *Store) GetPinnedMessages(ctx context.Context, chatID string) ([]model.Message, error) {
	var pins []model.ChatPin
	if err := s.db.WithContext(ctx).
		Where("chat_id = ?", chatID).
		Order("created_at DESC").
		Find(&pins).Error; err != nil {
		return nil, err
	}
	if len(pins) == 0 {
		return nil, nil
	}

	ids := make([]string, len(pins))
	for i := range pins {
		ids[i] = pins[i].MessageID
	}
	var messages []model.Message
	if err := s.db.WithContext(ctx).
		Where("chat_id = ? AND id IN ?", chatID, ids).
		Find(&messages).Error; err != nil {
		return nil, err
	}

	byID := make(map[string]model.Message, len(messages))
	for i := range messages {
		byID[messages[i].ID] = messages[i]
	}
	out := make([]model.Message, 0, len(messages))
	for _, id := range ids {
		if msg, ok := byID[id]; ok {
			out = append(out, msg)
		}
	}
	return out, nil
}
