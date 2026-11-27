package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"fast_chat/internal/textutil"
	"fast_chat/model"
)

const (
	legacyDeviceID = "legacy"

	// sessionTouchInterval throttles last_seen_at writes on the request path.
	sessionTouchInterval = 5 * time.Minute

	// sessionRotateGrace keeps the token replaced by a refresh usable for a
	// short window: two tabs of one device share the session row and may
	// refresh at the same moment, and the loser must not be logged out.
	sessionRotateGrace = 30 * time.Second

	// maxCachedRotations bounds the in-memory rotation cache. Only sessions
	// that refreshed inside the grace window occupy it.
	maxCachedRotations = 4096

	fieldTokenHash  = "token_hash"
	fieldLastSeenAt = "last_seen_at"
	fieldExpiresAt  = "expires_at"
	fieldRevokedAt  = "revoked_at"
	fieldPrevHash   = "prev_token_hash"
	fieldPrevExpiry = "prev_expires_at"
)

var (
	// ErrSessionNotFound reports that the session is unknown, already revoked
	// or has expired.
	ErrSessionNotFound = errors.New("session not found")
	errInvalidTTL      = errors.New("session ttl must be positive")
)

// GetSessionByToken resolves a bearer token to an active session and its user.
// A token rotated within the grace window still authenticates: the other tab
// of the same device holds it and has not refreshed yet.
func (s *Store) GetSessionByToken(ctx context.Context, token string) (*model.Session, *model.User, bool) {
	session, user, err := s.GetSessionByTokenE(ctx, token)
	if err != nil {
		return nil, nil, false
	}

	return session, user, true
}

// GetSessionByTokenE is GetSessionByToken with the storage failure reported
// separately: an expired token and an unreachable database must not look the
// same to the caller, or a transient outage answers 401 and the client throws
// away credentials that are still valid.
func (s *Store) GetSessionByTokenE(ctx context.Context, token string) (*model.Session, *model.User, error) {
	now := time.Now().UTC()

	var session model.Session
	err := s.db.WithContext(ctx).
		Where("(token_hash = ? OR (prev_token_hash = ? AND prev_expires_at > ?)) AND revoked_at IS NULL AND expires_at > ?",
			hashToken(token), hashToken(token), now, now).
		First(&session).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrSessionNotFound
		}

		return nil, nil, err
	}

	var user model.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", session.UserID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// A session without its account is not usable; the row is a
			// leftover the cleanup worker will remove.
			return nil, nil, ErrSessionNotFound
		}

		return nil, nil, err
	}

	return &session, &user, nil
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
					fieldTokenHash:  tokenHash,
					fieldPrevHash:   "",
					fieldPrevExpiry: nil,
					"device_name":   deviceName,
					"user_agent":    userAgent,
					fieldExpiresAt:  expiresAt,
					fieldLastSeenAt: now,
					fieldRevokedAt:  nil,
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

		return nil
	})
	if err != nil {
		return nil, "", err
	}

	// A fresh login supersedes any token handed out by a rotation.
	s.forgetRotation(session.ID)

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

// GetSessionsByIDs returns the sessions with the given IDs. Missing IDs are
// simply absent from the map. The lookup is chunked to stay below SQLite's
// bound-variable limit.
func (s *Store) GetSessionsByIDs(ctx context.Context, sessionIDs []string) (map[string]model.Session, error) {
	out := make(map[string]model.Session, len(sessionIDs))
	if len(sessionIDs) == 0 {
		return out, nil
	}

	for start := 0; start < len(sessionIDs); start += 500 {
		end := min(start+500, len(sessionIDs))
		var sessions []model.Session
		if err := s.db.WithContext(ctx).
			Where("id IN ?", sessionIDs[start:end]).
			Find(&sessions).Error; err != nil {
			return nil, err
		}
		for i := range sessions {
			out[sessions[i].ID] = sessions[i]
		}
	}

	return out, nil
}

// RefreshSession rotates the token of one session and extends its expiry. Two
// tabs of the same device share the session row and may refresh at the same
// moment; the rotation is made idempotent within sessionRotateGrace so both
// get one working token instead of killing each other's. The replaced token
// stays usable for the same window, covering requests already in flight.
func (s *Store) RefreshSession(ctx context.Context, sessionID string, ttl time.Duration) (*model.Session, string, error) {
	if ttl <= 0 {
		return nil, "", errInvalidTTL
	}

	now := time.Now().UTC()

	if cached, ok := s.recentRotation(sessionID, now); ok {
		session, found := s.GetSessionByID(ctx, sessionID)
		if !found || !session.Active(now) {
			return nil, "", ErrSessionNotFound
		}

		return session, cached, nil
	}

	token := GenerateID()

	var session model.Session
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&session, "id = ?", sessionID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrSessionNotFound
			}

			return err
		}
		if !session.Active(now) {
			return ErrSessionNotFound
		}

		// The compare-and-set on the hash keeps two writers from both
		// believing they rotated the same value; the loser simply retries
		// with the hash the winner stored.
		res := tx.Model(&model.Session{}).
			Where("id = ? AND token_hash = ?", sessionID, session.TokenHash).
			Updates(map[string]any{
				fieldTokenHash:  hashToken(token),
				fieldPrevHash:   session.TokenHash,
				fieldPrevExpiry: now.Add(sessionRotateGrace),
				fieldExpiresAt:  now.Add(ttl),
				fieldLastSeenAt: now,
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

		return nil
	})
	if err != nil {
		return nil, "", err
	}

	s.rememberRotation(sessionID, token, now)

	return &session, token, nil
}

// recentRotation returns the token issued by a rotation of the session within
// the grace window, so a concurrent refresh of the same device reuses it
// instead of minting a second token.
func (s *Store) recentRotation(sessionID string, now time.Time) (string, bool) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	cached, ok := s.lastRotations[sessionID]
	if !ok {
		return "", false
	}
	if now.Sub(cached.rotatedAt) >= sessionRotateGrace {
		delete(s.lastRotations, sessionID)

		return "", false
	}

	return cached.token, true
}

// rememberRotation stores the token of the last rotation and drops expired
// entries. The map is bounded: it only ever holds sessions that refreshed in
// the last window, and a full map is cleared of stale entries.
func (s *Store) rememberRotation(sessionID, token string, now time.Time) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	if len(s.lastRotations) >= maxCachedRotations {
		for id, cached := range s.lastRotations {
			if now.Sub(cached.rotatedAt) >= sessionRotateGrace {
				delete(s.lastRotations, id)
			}
		}
		if len(s.lastRotations) >= maxCachedRotations {
			s.lastRotations = make(map[string]cachedRotation)
		}
	}

	s.lastRotations[sessionID] = cachedRotation{token: token, rotatedAt: now}
}

// forgetRotation drops the cached token of a session that was revoked or
// recreated, so a stale entry cannot answer a later refresh.
func (s *Store) forgetRotation(sessionID string) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	delete(s.lastRotations, sessionID)
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
		Update(fieldLastSeenAt, now.UTC()).Error
}

// RevokeSession invalidates one session of the user and drops its push
// subscriptions in the same transaction, so a revoked device cannot receive
// another push even if the caller fails afterwards.
func (s *Store) RevokeSession(ctx context.Context, userID, sessionID string) error {
	now := time.Now().UTC()

	// Drop the cached rotation first: a revocation must not leave a token the
	// refresh path would happily hand out again.
	s.forgetRotation(sessionID)

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Session{}).
			Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessionID, userID).
			Updates(map[string]any{
				fieldRevokedAt:  now,
				fieldExpiresAt:  now,
				fieldTokenHash:  hashToken(GenerateID()),
				fieldPrevHash:   "",
				fieldPrevExpiry: nil,
			})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrSessionNotFound
		}

		// Delete this device's subscription and the legacy sessionless rows:
		// after a logout no push must reach a row that cannot be attributed to
		// an active session.
		if err := tx.Where("user_id = ? AND (session_id = ? OR session_id = '')", userID, sessionID).
			Delete(&model.PushSubscription{}).Error; err != nil {
			return err
		}

		return tx.Model(&model.UserDevice{}).
			Where("id = ? AND user_id = ?", sessionID, userID).
			Update("revoked_at", now).Error
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
		var err error
		revoked, err = revokeAllSessionsTx(tx, userID, now)

		return err
	})
	if err != nil {
		// The transaction rolled back, so report no revocations rather than a
		// partial count for rows that were never committed.
		return 0, err
	}

	return revoked, nil
}

// revokeAllSessionsTx is the logout-all cleanup shared by the user and the
// administrator paths: sessions are revoked one by one (each gets a fresh
// token hash), push subscriptions are deleted and the device keys are
// invalidated, all inside the caller's transaction.
func revokeAllSessionsTx(tx *gorm.DB, userID string, now time.Time) (int64, error) {
	var sessions []model.Session
	if err := tx.Select("id").
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Find(&sessions).Error; err != nil {
		return 0, err
	}

	var revoked int64
	for idx := range sessions {
		res := tx.Model(&model.Session{}).
			Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessions[idx].ID, userID).
			Updates(map[string]any{
				fieldRevokedAt:  now,
				fieldExpiresAt:  now,
				fieldTokenHash:  hashToken(GenerateID()),
				fieldPrevHash:   "",
				fieldPrevExpiry: nil,
			})
		if res.Error != nil {
			return 0, res.Error
		}
		revoked += res.RowsAffected
	}

	// Every subscription of the user is dead, including legacy rows with
	// an empty session id; logout-all must not leave a notification path.
	if err := tx.Where("user_id = ?", userID).Delete(&model.PushSubscription{}).Error; err != nil {
		return 0, err
	}

	return revoked, tx.Model(&model.UserDevice{}).
		Where("user_id = ? AND revoked_at IS NULL", userID).
		Update("revoked_at", now).Error
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
// together with their push subscriptions, in one transaction. The ids are
// deleted in chunks: SQLite has a bound-variable limit, and an unbounded
// IN (?) would stop the hourly cleanup from ever succeeding.
func (s *Store) DeleteOldSessions(ctx context.Context, before time.Time) (int64, error) {
	var deleted int64

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []string
		if err := tx.Model(&model.Session{}).
			Where("(revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?", before, before).
			Pluck("id", &ids).Error; err != nil {
			return err
		}

		for start := 0; start < len(ids); start += 500 {
			end := min(start+500, len(ids))
			chunk := ids[start:end]
			if err := tx.Where("session_id IN ?", chunk).Delete(&model.PushSubscription{}).Error; err != nil {
				return err
			}
			if err := tx.Where("id IN ?", chunk).Delete(&model.UserDevice{}).Error; err != nil {
				return err
			}
			res := tx.Where("id IN ?", chunk).Delete(&model.Session{})
			if res.Error != nil {
				return res.Error
			}
			deleted += res.RowsAffected
		}

		return nil
	})
	if err != nil {
		return 0, err
	}

	return deleted, nil
}

func truncateDeviceName(s string) string {
	return textutil.TruncateUTF8(strings.TrimSpace(s), 64)
}

func truncateUserAgent(s string) string {
	return textutil.TruncateUTF8(s, 512)
}
