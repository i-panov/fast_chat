package store

import (
	"context"
	"time"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

// UpsertUserDevice registers or refreshes the public key of one device. It is
// idempotent: the same device may upload a key again after recovery.
//
// revoked_at is deliberately not updated here: a revoked key must stay revoked
// even when the device re-registers on the next page load. Un-revoking is an
// explicit recovery action, not a side effect of an upsert.
func (s *Store) UpsertUserDevice(ctx context.Context, userID, deviceID, publicKey string) error {
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{colUserID, fieldPublicKey, fieldLastSeenAt}),
	}).Create(&model.UserDevice{
		ID:         deviceID,
		UserID:     userID,
		PublicKey:  publicKey,
		CreatedAt:  now,
		LastSeenAt: now,
	}).Error
}

func (s *Store) ListUserDevices(ctx context.Context, userID string) ([]model.UserDevice, error) {
	var devices []model.UserDevice
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Order("created_at ASC").
		Find(&devices).Error
	return devices, err
}

func (s *Store) RevokeUserDevice(ctx context.Context, userID, deviceID string) error {
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Model(&model.UserDevice{}).
		Where("id = ? AND user_id = ?", deviceID, userID).
		Updates(map[string]any{"revoked_at": now, fieldKeyBackup: "", fieldKeyBackupAt: nil}).Error
}
