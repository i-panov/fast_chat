package store

import (
	"context"
	"time"

	"gorm.io/gorm/clause"

	"fast_chat/model"
)

// federationCursorEpoch is the catch-up position of a peer that was never
// polled: everything it has for us is new to us.
var federationCursorEpoch = time.Unix(0, 0).UTC()

// EnqueueFederationOp stores a pending operation towards a peer. The
// operation is picked up by the outbox worker, which retries it until the
// peer accepts it.
func (s *Store) EnqueueFederationOp(ctx context.Context, op *model.FederationOp) error {
	if op.ID == "" {
		op.ID = GenerateID()
	}

	if op.CreatedAt.IsZero() {
		op.CreatedAt = time.Now().UTC()
	}

	if op.NextAttemptAt.IsZero() {
		op.NextAttemptAt = op.CreatedAt
	}

	return s.db.WithContext(ctx).Create(&op).Error
}

// DueFederationOps returns the operations that are ready to be sent, oldest
// first.
//
// The order matters: the peer applies the operations in the order they were
// created, so a chat has to exist before the messages in it.
//
// An operation is therefore only returned when no earlier operation of the
// same peer is still waiting. A failed operation is postponed, and until it is
// delivered it blocks the queue of its peer — also across the ticks: without
// that barrier the next tick would send the message of a chat whose creation
// is still queued, and the peer would answer 404.
func (s *Store) DueFederationOps(ctx context.Context, limit int) ([]*model.FederationOp, error) {
	var ops []*model.FederationOp

	now := time.Now().UTC()

	blockedByEarlier := `NOT EXISTS (
		SELECT 1 FROM federation_ops earlier
		WHERE earlier.remote_server = federation_ops.remote_server
			AND (earlier.created_at, earlier.id) < (federation_ops.created_at, federation_ops.id)
			AND earlier.next_attempt_at > ?
	)`

	query := s.db.WithContext(ctx).
		Where("next_attempt_at <= ?", now).
		Where(blockedByEarlier, now).
		Order("created_at ASC, id ASC")

	if limit > 0 {
		query = query.Limit(limit)
	}

	if err := query.Find(&ops).Error; err != nil {
		return nil, err
	}

	return ops, nil
}

// DeleteFederationOp removes a delivered operation.
func (s *Store) DeleteFederationOp(ctx context.Context, id string) error {
	return s.db.WithContext(ctx).Where("id = ?", id).Delete(&model.FederationOp{}).Error
}

// RescheduleFederationOp puts a failed operation back into the queue with a
// later attempt time.
func (s *Store) RescheduleFederationOp(ctx context.Context, id string, attempts int, nextAttemptAt time.Time, lastError string) error {
	return s.db.WithContext(ctx).Model(&model.FederationOp{}).Where("id = ?", id).
		Updates(map[string]any{
			"attempts":        attempts,
			"next_attempt_at": nextAttemptAt,
			"last_error":      lastError,
		}).Error
}

// GetFederationCursor returns the catch-up position of a peer. A peer that was
// never polled starts at the epoch: everything it has for us is new to us.
func (s *Store) GetFederationCursor(ctx context.Context, remoteServer string) time.Time {
	var cursor model.FederationCursor

	// Find instead of First: a peer without a cursor is the normal case, and
	// the "record not found" error of First would be logged every poll.
	result := s.db.WithContext(ctx).Where("remote_server = ?", remoteServer).Limit(1).Find(&cursor)
	if result.Error != nil || result.RowsAffected == 0 {
		return federationCursorEpoch
	}

	return cursor.LastSyncAt
}

// SetFederationCursor stores the catch-up position of a peer.
func (s *Store) SetFederationCursor(ctx context.Context, remoteServer string, at time.Time) error {
	cursor := model.FederationCursor{RemoteServer: remoteServer, LastSyncAt: at}

	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{UpdateAll: true}).
		Create(&cursor).Error
}

// GetFederatedServers returns the peers this server has a chat with. They
// are the servers the catch-up worker polls.
func (s *Store) GetFederatedServers(ctx context.Context) ([]string, error) {
	var servers []string

	if err := s.db.WithContext(ctx).Model(&model.Chat{}).
		Where("remote_server != ''").
		Distinct().
		Pluck("remote_server", &servers).Error; err != nil {
		return nil, err
	}

	return servers, nil
}
