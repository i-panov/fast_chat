package store

import (
	"context"
	"time"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

// AddPushSubscriptionForSession creates or refreshes the subscription of a
// session. The endpoint is unique across the table: the same browser endpoint
// re-subscribing for another session moves the row to that session.
func (s *Store) AddPushSubscriptionForSession(
	ctx context.Context,
	userID, sessionID, endpoint, p256dh, auth string,
) (*model.PushSubscription, error) {

	sub := &model.PushSubscription{
		ID:        GenerateID(),
		UserID:    userID,
		SessionID: sessionID,
		Endpoint:  endpoint,
		P256DH:    p256dh,
		Auth:      auth,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.Assignments(map[string]any{
			"user_id":    userID,
			"session_id": sessionID,
			"p256_dh":    p256dh,
			"auth":       auth,
		}),
	}).Create(sub).Error; err != nil {
		return nil, err
	}

	// OnConflict keeps the existing row (and its id) on a re-subscribe,
	// so the fresh GenerateID above is not the stored one. Re-read by the
	// unique endpoint to return the id the client must use to delete it.
	var stored model.PushSubscription
	if err := s.db.WithContext(ctx).Where("endpoint = ?", endpoint).First(&stored).Error; err != nil {
		return nil, err
	}

	return &stored, nil
}

// AddPushSubscription is the legacy user-only form. It writes a subscription
// with an empty session id, which is delivered only while the user is offline.
func (s *Store) AddPushSubscription(ctx context.Context, userID, endpoint, p256dh, auth string) (*model.PushSubscription, error) {
	return s.AddPushSubscriptionForSession(ctx, userID, "", endpoint, p256dh, auth)
}

func (s *Store) GetPushSubscriptionsByUser(ctx context.Context, userID string) ([]model.PushSubscription, error) {
	var subs []model.PushSubscription
	if err := s.db.WithContext(ctx).Where("user_id = ?", userID).Find(&subs).Error; err != nil {
		return nil, err
	}

	return subs, nil
}

func (s *Store) DeletePushSubscription(ctx context.Context, userID, endpoint string) error {
	return s.db.WithContext(ctx).Where("user_id = ? AND endpoint = ?", userID, endpoint).Delete(&model.PushSubscription{}).Error
}

// DeletePushSubscriptionForSession removes the subscription of one device.
// The endpoint is unique across the table, so it identifies the row, while the
// session guard keeps one device from deleting another device's subscription.
// When the endpoint has no row for the given session, a legacy subscription
// with an empty session id is removed instead.
func (s *Store) DeletePushSubscriptionForSession(ctx context.Context, userID, sessionID, endpoint string) error {
	res := s.db.WithContext(ctx).
		Where("user_id = ? AND endpoint = ? AND session_id = ?", userID, endpoint, sessionID).
		Delete(&model.PushSubscription{})
	if res.Error != nil {
		return res.Error
	}

	if res.RowsAffected > 0 || sessionID == "" {
		return nil
	}

	return s.db.WithContext(ctx).
		Where("user_id = ? AND endpoint = ? AND session_id = ''", userID, endpoint).
		Delete(&model.PushSubscription{}).Error
}

func (s *Store) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	return s.db.WithContext(ctx).Where("endpoint = ?", endpoint).Delete(&model.PushSubscription{}).Error
}

// DeletePushSubscriptionsBySession removes the subscriptions of one device
// session, leaving the other sessions of the user subscribed.
func (s *Store) DeletePushSubscriptionsBySession(ctx context.Context, sessionID string) error {
	return s.db.WithContext(ctx).Where("session_id = ?", sessionID).Delete(&model.PushSubscription{}).Error
}

// DeleteAllPushSubscriptions removes every subscription of the user, for
// every device. It is the logout-everywhere counterpart of
// DeletePushSubscriptionsBySession.
func (s *Store) DeleteAllPushSubscriptions(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.PushSubscription{}).Error
}
