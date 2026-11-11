package store

import (
	"context"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

func (s *Store) BlockUser(ctx context.Context, blockerID, blockedID string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).
		Create(&model.UserBlock{BlockerID: blockerID, BlockedID: blockedID}).Error
}

func (s *Store) UnblockUser(ctx context.Context, blockerID, blockedID string) error {
	return s.db.WithContext(ctx).
		Where("blocker_id = ? AND blocked_id = ?", blockerID, blockedID).
		Delete(&model.UserBlock{}).Error
}

// IsBlockedBetween reports whether either direction of the pair is blocked.
func (s *Store) IsBlockedBetween(ctx context.Context, firstID, secondID string) bool {
	var count int64
	err := s.db.WithContext(ctx).Model(&model.UserBlock{}).
		Where("(blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)",
			firstID, secondID, secondID, firstID).
		Count(&count).Error
	return err == nil && count > 0
}

// BlockedIDs returns the users blocked by userID.
func (s *Store) BlockedIDs(ctx context.Context, userID string) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&model.UserBlock{}).
		Where("blocker_id = ?", userID).
		Order("created_at DESC").
		Pluck("blocked_id", &ids).Error
	return ids, err
}

// BlockedByIDs returns the users who blocked userID.
func (s *Store) BlockedByIDs(ctx context.Context, userID string) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&model.UserBlock{}).
		Where("blocked_id = ?", userID).
		Pluck("blocker_id", &ids).Error
	return ids, err
}
