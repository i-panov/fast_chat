package store

import (
	"context"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

const legacyDeviceID = "legacy"

// backfillSessions gives every user that still has a token in users a legacy
// session, so tokens issued before the multi-device release keep working.
func backfillSessions(db *gorm.DB) error {
	now := time.Now().UTC()

	// Only the columns needed below: users also carries the key backup blob.
	// unixepoch keeps the comparison correct for legacy local-zone values.
	var users []model.User
	if err := db.Select("id", "token", "token_expires_at").
		Where("token <> '' AND unixepoch(token_expires_at) > unixepoch(?)", now).
		Find(&users).Error; err != nil {
		return err
	}

	for i := range users {
		user := &users[i]

		// A real-device session may already own this token hash: the login
		// path writes the same hash to users.token and sessions.token_hash.
		// Inserting a legacy row then would violate the unique index and
		// abort the next boot.
		var tokenSessions []model.Session
		if err := db.Select("id").Where("token_hash = ?", user.Token).
			Limit(1).Find(&tokenSessions).Error; err != nil {
			return err
		}
		if len(tokenSessions) > 0 {
			continue
		}

		var legacySessions []model.Session
		if err := db.Select("id").
			Where("user_id = ? AND device_id = ?", user.ID, legacyDeviceID).
			Limit(1).Find(&legacySessions).Error; err != nil {
			return err
		}
		if len(legacySessions) > 0 {
			// Reconcile a token rotated while the legacy row already existed,
			// and revive a legacy row revoked by an earlier logout.
			if err := db.Model(&model.Session{}).Where("id = ?", legacySessions[0].ID).
				Updates(map[string]any{
					"token_hash": user.Token,
					// Sessions are not in utcTimestampColumns and expires_at is
					// compared as SQL text, so store the instant in UTC.
					"expires_at": user.TokenExpiresAt.UTC(),
					"revoked_at": nil,
				}).Error; err != nil {
				return err
			}
			continue
		}

		session := model.Session{
			ID:         GenerateID(),
			UserID:     user.ID,
			DeviceID:   legacyDeviceID,
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
