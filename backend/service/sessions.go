package service

import (
	"context"
	"time"
	"unicode/utf8"

	"fast_chat/model"
	"fast_chat/store"
)

// Device field caps, in bytes. They match the session columns, so a client
// cannot store more than the schema intends (and device_id is indexed).
const (
	maxDeviceIDBytes        = 128
	maxDeviceNameBytes      = 64
	maxDeviceUserAgentBytes = 512
)

// DeviceInfo identifies the client that owns a session.
type DeviceInfo struct {
	ID        string
	Name      string
	UserAgent string
}

// normalizeDevice fills a missing device id and caps the client-provided
// strings, so a malformed client cannot write unbounded values.
func normalizeDevice(in DeviceInfo) DeviceInfo {
	if in.ID == "" {
		in.ID = "legacy-" + store.GenerateID()
	}

	in.ID = truncateUTF8(in.ID, maxDeviceIDBytes)
	in.Name = truncateUTF8(in.Name, maxDeviceNameBytes)
	in.UserAgent = truncateUTF8(in.UserAgent, maxDeviceUserAgentBytes)

	return in
}

// truncateUTF8 cuts s to at most max bytes without splitting a UTF-8 rune, so
// a truncated value never reaches the database as invalid text.
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

// sessionTTL keeps tests and partially configured servers from issuing
// sessions that expire immediately.
func (s *Service) sessionTTL() time.Duration {
	if s.cfg != nil && s.cfg.Auth.TokenExpiry > 0 {
		return s.cfg.Auth.TokenExpiry
	}

	return 24 * time.Hour
}

// Logout revokes only the given session and releases its realtime resources.
// The store deletes the session's push subscriptions in the same transaction.
func (s *Service) Logout(ctx context.Context, sessionID, userID string) error {
	if err := s.store.RevokeSession(ctx, userID, sessionID); err != nil {
		return err
	}

	if s.hub != nil {
		s.hub.CloseSession(sessionID)
	}

	return nil
}

// LogoutAll revokes every session of the user. The store deletes all push
// subscriptions of the user in the same transaction.
func (s *Service) LogoutAll(ctx context.Context, userID string) error {
	if _, err := s.store.RevokeAllSessions(ctx, userID); err != nil {
		return err
	}

	if s.hub != nil {
		s.hub.CloseUserSessions(userID)
	}

	return nil
}

// RevokeSession revokes another device of the user.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID string) error {
	return s.Logout(ctx, sessionID, userID)
}

// ListSessions returns the active sessions of the user.
func (s *Service) ListSessions(ctx context.Context, userID string) ([]model.Session, error) {
	return s.store.ListSessions(ctx, userID)
}

// RefreshSession rotates the token of the current session.
func (s *Service) RefreshSession(ctx context.Context, sessionID string) (*model.Session, string, error) {
	session, token, err := s.store.RefreshSession(ctx, sessionID, s.sessionTTL())
	if err != nil {
		return nil, "", err
	}

	if s.hub != nil {
		s.hub.UpdateSessionExpiry(sessionID, session.ExpiresAt)
	}

	return session, token, nil
}

// RunSessionCleanup removes sessions that expired or were revoked long ago.
func (s *Service) RunSessionCleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
			if removed, err := s.store.DeleteOldSessions(ctx, cutoff); err != nil {
				log().Warn("session cleanup failed", "err", err)
			} else if removed > 0 {
				log().Info("removed old sessions", "count", removed)
			}
		}
	}
}

// trimSessions revokes the oldest sessions above the configured cap and
// releases their realtime resources.
func (s *Service) trimSessions(ctx context.Context, userID, keepID string) {
	if s.cfg == nil {
		return
	}

	revoked, err := s.store.TrimSessions(ctx, userID, s.cfg.Auth.MaxSessionsPerUser, keepID)
	if err != nil {
		// TrimSessions reports the sessions it already revoked before the
		// failure: clean them up instead of leaving their SSE streams and
		// push subscriptions behind.
		log().Warn("failed to trim sessions", "userID", userID, "err", err)
	}

	for _, sessionID := range revoked {
		if s.hub != nil {
			s.hub.CloseSession(sessionID)
		}
	}
}
