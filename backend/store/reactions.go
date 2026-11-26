package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

// AddMessageReaction is idempotent: the composite primary key makes a
// repeated click on the same emoji a no-op.
func (s *Store) AddMessageReaction(ctx context.Context, messageID, userID, emoji string) error {
	return s.AddMessageReactionAt(ctx, messageID, userID, emoji, time.Now().UTC())
}

// AddMessageReactionAt applies an add at the given instant. A stale event
// (older than the tombstone left by a later removal) is ignored, so a delayed
// federation retry cannot resurrect a reaction the user already removed.
func (s *Store) AddMessageReactionAt(ctx context.Context, messageID, userID, emoji string, at time.Time) error {
	at = at.UTC()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var tombstone model.ReactionDeletion
		err := tx.First(&tombstone,
			"message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Error
		switch {
		case err == nil && tombstone.RemovedAt.After(at):
			return nil
		case err == nil:
			if delErr := tx.Delete(&model.ReactionDeletion{},
				"message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Error; delErr != nil {
				return delErr
			}
		case !errors.Is(err, gorm.ErrRecordNotFound):
			return err
		}

		return tx.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&model.MessageReaction{
				MessageID: messageID,
				UserID:    userID,
				Emoji:     emoji,
				CreatedAt: at,
			}).Error
	})
}

// RemoveMessageReaction removes the emoji and records a tombstone for the
// federation catch-up.
func (s *Store) RemoveMessageReaction(ctx context.Context, messageID, userID, emoji string) error {
	return s.RemoveMessageReactionAt(ctx, messageID, userID, emoji, time.Now().UTC())
}

// RemoveMessageReactionAt applies a removal at the given instant. A stale
// removal (older than the reaction it targets) is ignored, mirroring
// AddMessageReactionAt.
func (s *Store) RemoveMessageReactionAt(ctx context.Context, messageID, userID, emoji string, at time.Time) error {
	at = at.UTC()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing model.MessageReaction
		err := tx.First(&existing,
			"message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Error
		switch {
		case err == nil && existing.CreatedAt.After(at):
			return nil
		case err == nil:
			if delErr := tx.Delete(&model.MessageReaction{},
				"message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Error; delErr != nil {
				return delErr
			}
		case !errors.Is(err, gorm.ErrRecordNotFound):
			return err
		}

		var tombstone model.ReactionDeletion
		err = tx.First(&tombstone,
			"message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Error
		switch {
		case err == nil:
			if tombstone.RemovedAt.After(at) {
				return nil
			}
			return tx.Model(&model.ReactionDeletion{}).
				Where("message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).
				Update("removed_at", at).Error
		case !errors.Is(err, gorm.ErrRecordNotFound):
			return err
		}

		return tx.Create(&model.ReactionDeletion{
			MessageID: messageID,
			UserID:    userID,
			Emoji:     emoji,
			RemovedAt: at,
		}).Error
	})
}

// ReactionsChangedSince returns a page of live reactions on messages of the
// given chats, for the federation catch-up. The keyset cursor is
// (created_at, message_id|user_id|emoji).
//
//nolint:dupl // mirrors ReactionDeletionsSince; the row types differ.
func (s *Store) ReactionsChangedSince(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.MessageReaction], error) {

	if len(chatIDs) == 0 {
		return DeltaPage[model.MessageReaction]{}, nil
	}
	if limit <= 0 {
		limit = DefaultSyncPageLimit
	}
	since = since.UTC()
	parts := reactionCursorParts(sinceID)

	var rows []model.MessageReaction
	if err := s.db.WithContext(ctx).
		Where("EXISTS (SELECT 1 FROM messages WHERE messages.id = message_reactions.message_id AND messages.chat_id IN ?)", chatIDs).
		Where("(created_at, message_id, user_id, emoji) > (?, ?, ?, ?)",
			since, parts[0], parts[1], parts[2]).
		Order("created_at ASC, message_id ASC, user_id ASC, emoji ASC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return DeltaPage[model.MessageReaction]{}, err
	}
	if len(rows) == 0 {
		return DeltaPage[model.MessageReaction]{}, nil
	}

	last := rows[len(rows)-1]
	return DeltaPage[model.MessageReaction]{
		Rows:      rows,
		NextSince: last.CreatedAt,
		NextID:    reactionCursorID(last.MessageID, last.UserID, last.Emoji),
		HasMore:   len(rows) == limit,
	}, nil
}

// ReactionDeletionsSince returns the reaction tombstones of the given chats
// after the cursor, for the federation catch-up. The keyset cursor is
// (removed_at, message_id|user_id|emoji).
//
//nolint:dupl // mirrors ReactionsChangedSince; the row types differ.
func (s *Store) ReactionDeletionsSince(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.ReactionDeletion], error) {

	if len(chatIDs) == 0 {
		return DeltaPage[model.ReactionDeletion]{}, nil
	}
	if limit <= 0 {
		limit = DefaultSyncPageLimit
	}
	since = since.UTC()
	parts := reactionCursorParts(sinceID)

	var rows []model.ReactionDeletion
	if err := s.db.WithContext(ctx).
		Where("EXISTS (SELECT 1 FROM messages WHERE messages.id = reaction_deletions.message_id AND messages.chat_id IN ?)", chatIDs).
		Where("(removed_at, message_id, user_id, emoji) > (?, ?, ?, ?)",
			since, parts[0], parts[1], parts[2]).
		Order("removed_at ASC, message_id ASC, user_id ASC, emoji ASC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return DeltaPage[model.ReactionDeletion]{}, err
	}
	if len(rows) == 0 {
		return DeltaPage[model.ReactionDeletion]{}, nil
	}

	last := rows[len(rows)-1]
	return DeltaPage[model.ReactionDeletion]{
		Rows:      rows,
		NextSince: last.RemovedAt,
		NextID:    reactionCursorID(last.MessageID, last.UserID, last.Emoji),
		HasMore:   len(rows) == limit,
	}, nil
}

// PruneReactionDeletions removes old tombstones. They only need to outlive
// the slowest catch-up cursor; a month is far beyond the retry budget.
func (s *Store) PruneReactionDeletions(ctx context.Context, before time.Time) (int64, error) {
	result := s.db.WithContext(ctx).Where("removed_at < ?", before.UTC()).
		Delete(&model.ReactionDeletion{})
	return result.RowsAffected, result.Error
}

func reactionCursorID(messageID, userID, emoji string) string {
	return messageID + "|" + userID + "|" + emoji
}

func reactionCursorParts(cursorID string) [3]string {
	parts := [3]string{"", "", ""}
	if cursorID == "" {
		return parts
	}
	split := strings.SplitN(cursorID, "|", 3)
	copy(parts[:], split)
	return parts
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
