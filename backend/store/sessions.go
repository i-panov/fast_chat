package store

import (
	"context"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

// backfillSessions gives every user that still has a token in users a legacy
// session, so tokens issued before the multi-device release keep working.
func backfillSessions(db *gorm.DB) error {
	var users []model.User
	if err := db.Where("token <> ''").Find(&users).Error; err != nil {
		return err
	}

	now := time.Now().UTC()
	for i := range users {
		user := &users[i]
		var existing int64
		if err := db.Model(&model.Session{}).
			Where("user_id = ? AND device_id = ?", user.ID, "legacy").
			Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			continue
		}

		session := model.Session{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   "legacy",
			DeviceName: "Legacy session",
			TokenHash:  user.Token,
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  user.TokenExpiresAt.UTC(),
		}
		if err := db.Create(&session).Error; err != nil {
			return err
		}
	}

	return nil
}

// GetSessionByToken resolves a bearer token to an active session and its user.
func (s *Store) GetSessionByToken(ctx context.Context, token string) (*model.Session, *model.User, bool) {
	var session model.Session
	err := s.db.WithContext(ctx).
		Where("token_hash = ? AND revoked_at IS NULL AND expires_at > ?", hashToken(token), time.Now().UTC()).
		First(&session).Error
	if err != nil {
		return nil, nil, false
	}

	var user model.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", session.UserID).Error; err != nil {
		return nil, nil, false
	}

	return &session, &user, true
}
