package store

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"

	"fast_chat/model"
)

const (
	legacyDeviceID = "legacy"

	// sessionTouchInterval throttles last_seen_at writes on the request path.
	sessionTouchInterval = 5 * time.Minute

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

// backfillSessions gives every legacy user that has no session rows at all a
// legacy session, so tokens issued before the multi-device release keep
// working after the upgrade.
//
// Once a user has any row in sessions — active, revoked, legacy or
// real-device — the sessions table is authoritative and users.token is
// ignored. Reconciling or reviving a session from users.token would let a
// logout or refresh undone by a restart: the stored legacy token hash may be
// stale after RefreshSession and still present after RevokeSession.
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

		var sessionCount int64
		if err := db.Model(&model.Session{}).Where("user_id = ?", user.ID).
			Count(&sessionCount).Error; err != nil {
			return err
		}
		if sessionCount > 0 {
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

// mirrorUserToken keeps the legacy users.token columns in step with the
// session token they describe. Nothing authenticates against them any more,
// but they remain the source for users that predate the sessions table, so a
// stale value is exactly what a restart would resurrect. It writes through the
// caller's transaction, so the session change and the mirror commit together.
func mirrorUserToken(tx *gorm.DB, userID, tokenHash string, expiresAt time.Time) error {
	return tx.Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{
			fieldToken:         tokenHash,
			fieldTokenExpireAt: expiresAt.UTC(),
		}).Error
}

// revokeUserToken invalidates the legacy users.token columns through the
// caller's transaction.
func revokeUserToken(tx *gorm.DB, userID string) error {
	return tx.Model(&model.User{}).Where("id = ?", userID).
		Updates(map[string]any{
			fieldToken:         hashToken(GenerateID()),
			fieldTokenExpireAt: time.Now().UTC(),
		}).Error
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
	deviceName = truncateDeviceName(deviceName)
	userAgent = truncateUserAgent(userAgent)

	var session model.Session
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		err := tx.Where("user_id = ? AND device_id = ?", userID, deviceID).
			First(&session).Error

		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			session = model.Session{
				ID:         GenerateID(),
				UserID:     userID,
				DeviceID:   deviceID,
				DeviceName: deviceName,
				TokenHash:  tokenHash,
				UserAgent:  userAgent,
				CreatedAt:  now,
				LastSeenAt: now,
				ExpiresAt:  expiresAt,
			}

			if err := tx.Create(&session).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			if err := tx.Model(&model.Session{}).
				Where("id = ?", session.ID).
				Updates(map[string]any{
					fieldTokenHash: tokenHash,
					"device_name":  deviceName,
					"user_agent":   userAgent,
					fieldExpiresAt: expiresAt,
					"last_seen_at": now,
					fieldRevokedAt: nil,
				}).Error; err != nil {
				return err
			}

			session.DeviceName = deviceName
			session.UserAgent = userAgent
			session.TokenHash = tokenHash
			session.ExpiresAt = expiresAt
			session.LastSeenAt = now
			session.RevokedAt = nil
		}

		return mirrorUserToken(tx, userID, tokenHash, expiresAt)
	})
	if err != nil {
		return nil, "", err
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

	var session model.Session
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Session{}).
			Where("id = ? AND revoked_at IS NULL AND expires_at > ?", sessionID, now).
			Updates(map[string]any{
				fieldTokenHash: hashToken(token),
				fieldExpiresAt: now.Add(ttl),
				"last_seen_at": now,
			})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrSessionNotFound
		}

		if err := tx.First(&session, "id = ?", sessionID).Error; err != nil {
			return err
		}
		if session.RevokedAt != nil {
			return ErrSessionNotFound
		}

		return mirrorUserToken(tx, session.UserID, session.TokenHash, session.ExpiresAt)
	})
	if err != nil {
		return nil, "", err
	}

	return &session, token, nil
}

// TouchSession advances last_seen_at when the recorded value is older than
// the throttle window. The conditional update keeps authenticated requests
// from writing the sessions row on every call.
func (s *Store) TouchSession(ctx context.Context, sessionID string, now time.Time) error {
	if sessionID == "" {
		return nil
	}

	return s.db.WithContext(ctx).Model(&model.Session{}).
		Where("id = ? AND unixepoch(last_seen_at) < unixepoch(?)", sessionID, now.Add(-sessionTouchInterval)).
		Update("last_seen_at", now.UTC()).Error
}

// RevokeSession invalidates one session of the user and drops its push
// subscriptions in the same transaction, so a revoked device cannot receive
// another push even if the caller fails afterwards.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	now := time.Now().UTC()

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Session{}).
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

		if err := tx.Where("session_id = ?", sessionID).Delete(&model.PushSubscription{}).Error; err != nil {
			return err
		}

		// users.token is no longer authoritative, but clearing it keeps a
		// stale value from becoming a resurrection source for an old database.
		return revokeUserToken(tx, userID)
	})
}

// RevokeAllSessions invalidates every active session of the user.
//
// The sessions are revoked one by one because each row gets its own fresh
// token hash: a single UPDATE would write the same hash into every row and
// violate the unique index on token_hash as soon as the user has two sessions.
func (s *Store) RevokeAllSessions(ctx context.Context, userID string) (int64, error) {
	now := time.Now().UTC()

	var revoked int64
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var sessions []model.Session
		if err := tx.Select("id").
			Where("user_id = ? AND revoked_at IS NULL", userID).
			Find(&sessions).Error; err != nil {
			return err
		}

		revoked = 0
		revokedIDs := make([]string, 0, len(sessions))
		for idx := range sessions {
			res := tx.Model(&model.Session{}).
				Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessions[idx].ID, userID).
				Updates(map[string]any{
					fieldRevokedAt: now,
					fieldExpiresAt: now,
					fieldTokenHash: hashToken(GenerateID()),
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected > 0 {
				revokedIDs = append(revokedIDs, sessions[idx].ID)
				revoked += res.RowsAffected
			}
		}

		if len(revokedIDs) > 0 {
			if err := tx.Where("session_id IN ?", revokedIDs).Delete(&model.PushSubscription{}).Error; err != nil {
				return err
			}
		}

		// The legacy columns must not keep a token that no longer has a session.
		return revokeUserToken(tx, userID)
	})
	if err != nil {
		// The transaction rolled back, so report no revocations rather than a
		// partial count for rows that were never committed.
		return 0, err
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

// DeleteOldSessions removes sessions that expired or were revoked long ago,
// together with their push subscriptions, in one transaction.
func (s *Store) DeleteOldSessions(ctx context.Context, before time.Time) (int64, error) {
	var deleted int64

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []string
		if err := tx.Model(&model.Session{}).
			Where("(revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?", before, before).
			Pluck("id", &ids).Error; err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}

		if err := tx.Where("session_id IN ?", ids).Delete(&model.PushSubscription{}).Error; err != nil {
			return err
		}

		res := tx.Where("id IN ?", ids).Delete(&model.Session{})
		deleted = res.RowsAffected

		return res.Error
	})
	if err != nil {
		return 0, err
	}

	return deleted, nil
}

func truncateDeviceName(s string) string {
	return truncateUTF8(strings.TrimSpace(s), 64)
}

func truncateUserAgent(s string) string {
	return truncateUTF8(s, 512)
}

// truncateUTF8 cuts s to at most max bytes without splitting a UTF-8 rune, so
// a stored device name or user agent is always valid text.
func truncateUTF8(value string, limit int) string {
	if len(value) <= limit {
		return value
	}

	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}

	return value[:cut]
}
