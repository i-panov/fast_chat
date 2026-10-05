package store

import (
	"context"
	"time"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

func (s *Store) AddPushSubscription(ctx context.Context, userID, endpoint, p256dh, auth string) (*model.PushSubscription, error) {
	sub := &model.PushSubscription{
		ID:        GenerateID(),
		UserID:    userID,
		Endpoint:  endpoint,
		P256DH:    p256dh,
		Auth:      auth,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.Assignments(map[string]any{
			"user_id": userID,
			"p256_dh": p256dh,
			"auth":    auth,
		}),
	}).Create(sub).Error; err != nil {
		return nil, err
	}

	return sub, nil
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

func (s *Store) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	return s.db.WithContext(ctx).Where("endpoint = ?", endpoint).Delete(&model.PushSubscription{}).Error
}
