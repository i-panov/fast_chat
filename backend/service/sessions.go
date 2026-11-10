package service

import (
	"context"
	"time"

	"fast_chat/model"
	"fast_chat/store"
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

	if len(in.Name) > 64 {
		in.Name = in.Name[:64]
	}

	if len(in.UserAgent) > 512 {
		in.UserAgent = in.UserAgent[:512]
	}

	return in
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
func (s *Service) Logout(ctx context.Context, sessionID, userID string) error {
	if err := s.store.RevokeSession(ctx, userID, sessionID); err != nil {
		return err
	}

	if err := s.store.DeletePushSubscriptionsBySession(ctx, sessionID); err != nil {
		log().Warn("failed to delete push subscriptions", "sessionID", sessionID, "err", err)
	}

	if s.hub != nil {
		s.hub.CloseSession(sessionID)
	}

	return nil
}

// LogoutAll revokes every session of the user.
func (s *Service) LogoutAll(ctx context.Context, userID string) error {
	if _, err := s.store.RevokeAllSessions(ctx, userID); err != nil {
		return err
	}

	if err := s.store.DeleteAllPushSubscriptions(ctx, userID); err != nil {
		log().Warn("failed to delete push subscriptions", "userID", userID, "err", err)
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

// trimSessions revokes the oldest sessions above the configured cap and
// releases their realtime resources.
func (s *Service) trimSessions(ctx context.Context, userID, keepID string) {
	if s.cfg == nil {
		return
	}

	revoked, err := s.store.TrimSessions(ctx, userID, s.cfg.Auth.MaxSessionsPerUser, keepID)
	if err != nil {
		log().Warn("failed to trim sessions", "userID", userID, "err", err)

		return
	}

	for _, sessionID := range revoked {
		if s.hub != nil {
			s.hub.CloseSession(sessionID)
		}

		if err := s.store.DeletePushSubscriptionsBySession(ctx, sessionID); err != nil {
			log().Warn("failed to delete push subscriptions", "sessionID", sessionID, "err", err)
		}
	}
}
