package store

import (
	"context"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

// AddMessageReaction is idempotent: the composite primary key makes a
// repeated click on the same emoji a no-op.
func (s *Store) AddMessageReaction(ctx context.Context, messageID, userID, emoji string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).
		Create(&model.MessageReaction{
			MessageID: messageID,
			UserID:    userID,
			Emoji:     emoji,
		}).Error
}

func (s *Store) RemoveMessageReaction(ctx context.Context, messageID, userID, emoji string) error {
	return s.db.WithContext(ctx).
		Where("message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).
		Delete(&model.MessageReaction{}).Error
}

// GetMessageReactionRows returns the raw rows of one message. The service
// uses them to build a per-member SSE payload without a query per member.
func (s *Store) GetMessageReactionRows(ctx context.Context, messageID string) ([]model.MessageReaction, error) {
	var rows []model.MessageReaction
	err := s.db.WithContext(ctx).
		Where("message_id = ?", messageID).
		Order("created_at ASC").
		Find(&rows).Error
	return rows, err
}

// GetReactionsForMessages aggregates reactions for a page of messages.
// Missing ids are simply absent from the map.
func (s *Store) GetReactionsForMessages(
	ctx context.Context,
	messageIDs []string,
	viewerID string,
) (map[string][]model.ReactionSummary, error) {

	out := make(map[string][]model.ReactionSummary, len(messageIDs))
	if len(messageIDs) == 0 {
		return out, nil
	}

	for start := 0; start < len(messageIDs); start += 500 {
		end := min(start+500, len(messageIDs))
		var rows []model.MessageReaction
		if err := s.db.WithContext(ctx).
			Where("message_id IN ?", messageIDs[start:end]).
			Order("created_at ASC").
			Find(&rows).Error; err != nil {
			return nil, err
		}

		for _, row := range rows {
			summaries := out[row.MessageID]
			found := false
			for idx := range summaries {
				if summaries[idx].Emoji != row.Emoji {
					continue
				}
				summaries[idx].Count++
				if row.UserID == viewerID {
					summaries[idx].Me = true
				}
				found = true
				break
			}
			if !found {
				out[row.MessageID] = append(out[row.MessageID], model.ReactionSummary{
					Emoji: row.Emoji,
					Count: 1,
					Me:    row.UserID == viewerID,
				})
			}
		}
	}

	return out, nil
}
