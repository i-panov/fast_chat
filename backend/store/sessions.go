package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

const (
	legacyDeviceID = "legacy"

	fieldTokenHash = "token_hash"
	fieldExpiresAt = "expires_at"
	fieldRevokedAt = "revoked_at"
)

var (
	// ErrSessionNotFound reports that the session is unknown, already revoked
	// or has expired.
	ErrSessionNotFound = errors.New("session not found")
	errInvalidTTL      = errors.New("session ttl must be positive")
)

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
					fieldTokenHash: user.Token,
					// Sessions are not in utcTimestampColumns and expires_at is
					// compared as SQL text, so store the instant in UTC.
					fieldExpiresAt: user.TokenExpiresAt.UTC(),
					fieldRevokedAt: nil,
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

// CreateSession creates or replaces the session of a device. It returns the
// session and the plaintext token, which is never stored.
func (s *Store) CreateSession(
	ctx context.Context, userID, deviceID, deviceName, userAgent string, ttl time.Duration,
) (*model.Session, string, error) {

	if userID == "" {
		return nil, "", ErrSessionNotFound
	}
	if ttl <= 0 {
		return nil, "", errInvalidTTL
	}
	if deviceID == "" {
		deviceID = "legacy-" + GenerateID()
	}

	token := GenerateID()
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	tokenHash := hashToken(token)

	var session model.Session
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND device_id = ?", userID, deviceID).
		First(&session).Error

	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		session = model.Session{
			ID:         GenerateID(),
			UserID:     userID,
			DeviceID:   deviceID,
			DeviceName: truncateDeviceName(deviceName),
			TokenHash:  tokenHash,
			UserAgent:  truncateUserAgent(userAgent),
			CreatedAt:  now,
			LastSeenAt: now,
			ExpiresAt:  expiresAt,
		}
		if err := s.db.WithContext(ctx).Create(&session).Error; err != nil {
			return nil, "", err
		}
	case err != nil:
		return nil, "", err
	default:
		if err := s.db.WithContext(ctx).Model(&model.Session{}).
			Where("id = ?", session.ID).
			Updates(map[string]any{
				fieldTokenHash: tokenHash,
				"device_name":  truncateDeviceName(deviceName),
				"user_agent":   truncateUserAgent(userAgent),
				fieldExpiresAt: expiresAt,
				"last_seen_at": now,
				fieldRevokedAt: nil,
			}).Error; err != nil {
			return nil, "", err
		}
		session.DeviceName = truncateDeviceName(deviceName)
		session.UserAgent = truncateUserAgent(userAgent)
		session.TokenHash = tokenHash
		session.ExpiresAt = expiresAt
		session.LastSeenAt = now
		session.RevokedAt = nil
	}

	return &session, token, nil
}

// GetSessionByID returns a session regardless of its state: SSE heartbeat
// needs to distinguish "revoked" from "not found".
func (s *Store) GetSessionByID(ctx context.Context, sessionID string) (*model.Session, bool) {
	var session model.Session
	if err := s.db.WithContext(ctx).First(&session, "id = ?", sessionID).Error; err != nil {
		return nil, false
	}
	return &session, true
}

// RefreshSession rotates the token of one session and extends its expiry.
func (s *Store) RefreshSession(ctx context.Context, sessionID string, ttl time.Duration) (*model.Session, string, error) {
	if ttl <= 0 {
		return nil, "", errInvalidTTL
	}

	now := time.Now().UTC()
	token := GenerateID()
	res := s.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND revoked_at IS NULL AND expires_at > ?", sessionID, now).
		Updates(map[string]any{
			fieldTokenHash: hashToken(token),
			fieldExpiresAt: now.Add(ttl),
			"last_seen_at": now,
		})
	if res.Error != nil {
		return nil, "", res.Error
	}
	if res.RowsAffected == 0 {
		return nil, "", ErrSessionNotFound
	}

	var session model.Session
	if err := s.db.WithContext(ctx).First(&session, "id = ?", sessionID).Error; err != nil {
		return nil, "", err
	}

	return &session, token, nil
}

// RevokeSession invalidates one session of the user.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessionID, userID).
		Updates(map[string]any{
			fieldRevokedAt: now,
			fieldExpiresAt: now,
			fieldTokenHash: hashToken(GenerateID()),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// RevokeAllSessions invalidates every active session of the user.
//
// The sessions are revoked one by one because each row gets its own fresh
// token hash: a single UPDATE would write the same hash into every row and
// violate the unique index on token_hash as soon as the user has two sessions.
func (s *Store) RevokeAllSessions(ctx context.Context, userID string) (int64, error) {
	now := time.Now().UTC()

	var sessions []model.Session
	if err := s.db.WithContext(ctx).Select("id").
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Find(&sessions).Error; err != nil {
		return 0, err
	}

	var revoked int64
	for idx := range sessions {
		res := s.db.WithContext(ctx).Model(&model.Session{}).
			Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessions[idx].ID, userID).
			Updates(map[string]any{
				fieldRevokedAt: now,
				fieldExpiresAt: now,
				fieldTokenHash: hashToken(GenerateID()),
			})
		if res.Error != nil {
			return revoked, res.Error
		}
		revoked += res.RowsAffected
	}

	return revoked, nil
}

// ListSessions returns active sessions, newest activity first.
func (s *Store) ListSessions(ctx context.Context, userID string) ([]model.Session, error) {
	var sessions []model.Session
	err := s.db.WithContext(ctx).
		Where("user_id = ? AND revoked_at IS NULL AND expires_at > ?", userID, time.Now().UTC()).
		Order("last_seen_at DESC").
		Find(&sessions).Error
	return sessions, err
}

// TrimSessions revokes the oldest sessions above limit, excluding keepID.
func (s *Store) TrimSessions(ctx context.Context, userID string, limit int, keepID string) ([]string, error) {
	if limit <= 0 {
		return nil, nil
	}

	var sessions []model.Session
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND revoked_at IS NULL AND expires_at > ?", userID, time.Now().UTC()).
		Order("last_seen_at ASC").
		Find(&sessions).Error; err != nil {
		return nil, err
	}
	if len(sessions) <= limit {
		return nil, nil
	}

	excess := len(sessions) - limit
	revoked := make([]string, 0, excess)
	for idx := range sessions {
		if excess == 0 {
			break
		}
		if sessions[idx].ID == keepID {
			continue
		}
		if err := s.RevokeSession(ctx, userID, sessions[idx].ID); err != nil {
			return revoked, err
		}
		revoked = append(revoked, sessions[idx].ID)
		excess--
	}
	return revoked, nil
}

// DeleteOldSessions removes sessions that expired or were revoked long ago.
func (s *Store) DeleteOldSessions(ctx context.Context, before time.Time) (int64, error) {
	res := s.db.WithContext(ctx).
		Where("(revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?", before, before).
		Delete(&model.Session{})
	return res.RowsAffected, res.Error
}

func truncateDeviceName(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 64 {
		return s[:64]
	}
	return s
}

func truncateUserAgent(s string) string {
	if len(s) > 512 {
		return s[:512]
	}
	return s
}
