package store

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

const (
	statusRead      = "read"
	statusDelivered = "delivered"
	colMessageID    = "message_id"
	colUserID       = "user_id"
	colStatus       = "status"
	colReadAt       = "read_at"
)

// readStatusBulkChunk bounds one bulk upsert. A status row binds four
// columns, so this stays far below the driver's variable ceiling.
const readStatusBulkChunk = 2000

// MarkMessagesRead marks messages as read for a user. Uses upsert to
// handle the case where a status already exists (e.g. delivered -> read).
func (s *Store) MarkMessagesRead(ctx context.Context, messageIDs []string, userID string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	now := time.Now().UTC()

	for start := 0; start < len(messageIDs); start += readStatusBulkChunk {
		end := min(start+readStatusBulkChunk, len(messageIDs))

		statuses := make([]model.MessageReadStatus, 0, end-start)
		for _, msgID := range messageIDs[start:end] {
			statuses = append(statuses, model.MessageReadStatus{
				MessageID: msgID,
				UserID:    userID,
				Status:    statusRead,
				ReadAt:    now,
			})
		}

		if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: colMessageID}, {Name: colUserID}},
			DoUpdates: clause.AssignmentColumns([]string{colStatus, colReadAt}),
		}).Create(&statuses).Error; err != nil {
			return err
		}
	}

	return nil
}

// MarkMessagesDelivered marks messages as delivered for a user. Uses upsert
// but does not overwrite "read" status (read is higher priority than delivered).
func (s *Store) MarkMessagesDelivered(ctx context.Context, messageIDs []string, userID string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	now := time.Now().UTC()

	for start := 0; start < len(messageIDs); start += readStatusBulkChunk {
		end := min(start+readStatusBulkChunk, len(messageIDs))

		statuses := make([]model.MessageReadStatus, 0, end-start)
		for _, msgID := range messageIDs[start:end] {
			statuses = append(statuses, model.MessageReadStatus{
				MessageID: msgID,
				UserID:    userID,
				Status:    statusDelivered,
				ReadAt:    now,
			})
		}

		if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: colMessageID}, {Name: colUserID}},
			DoUpdates: clause.Assignments(map[string]any{
				colStatus: gorm.Expr("CASE WHEN "+colStatus+" = ? THEN ? ELSE ? END", statusRead, statusRead, statusDelivered),
				colReadAt: gorm.Expr("CASE WHEN "+colStatus+" = ? THEN "+colReadAt+" ELSE ? END", statusRead, now),
			}),
		}).Create(&statuses).Error; err != nil {
			return err
		}
	}

	return nil
}

// GetMessageReadStatusesBatch returns read statuses for a user for the given messages.
// Returns map[messageID]status.
func (s *Store) GetMessageReadStatusesBatch(ctx context.Context, messageIDs []string, userID string) (map[string]string, error) {
	if len(messageIDs) == 0 {
		return map[string]string{}, nil
	}

	var statuses []model.MessageReadStatus
	for start := 0; start < len(messageIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(messageIDs))

		var chunk []model.MessageReadStatus
		if err := s.db.WithContext(ctx).
			Where(colMessageID+" IN ? AND "+colUserID+" = ?", messageIDs[start:end], userID).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		statuses = append(statuses, chunk...)
	}

	result := make(map[string]string, len(statuses))
	for _, st := range statuses {
		result[st.MessageID] = st.Status
	}

	return result, nil
}

// GetMessageReadStatusesForSender returns the list of user IDs who read
// each message. Used to show read receipts to the message sender.
// Returns map[messageID][]userID.
func (s *Store) GetMessageReadStatusesForSender(ctx context.Context, messageIDs []string, senderID string) (map[string][]string, error) {
	if len(messageIDs) == 0 {
		return map[string][]string{}, nil
	}

	// Find messages sent by the sender
	var sentMessages []*model.Message
	for start := 0; start < len(messageIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(messageIDs))

		var chunk []*model.Message
		if err := s.db.WithContext(ctx).
			Where("id IN ? AND from_id = ?", messageIDs[start:end], senderID).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		sentMessages = append(sentMessages, chunk...)
	}

	if len(sentMessages) == 0 {
		return map[string][]string{}, nil
	}

	sentIDs := make([]string, len(sentMessages))
	for i, m := range sentMessages {
		sentIDs[i] = m.ID
	}

	// Get read statuses for those messages (excluding the sender themselves)
	var readStatuses []model.MessageReadStatus
	for start := 0; start < len(sentIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(sentIDs))

		var chunk []model.MessageReadStatus
		if err := s.db.WithContext(ctx).
			Where(colMessageID+" IN ? AND "+colUserID+" != ? AND "+colStatus+" = ?", sentIDs[start:end], senderID, statusRead).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		readStatuses = append(readStatuses, chunk...)
	}

	result := make(map[string][]string, len(sentMessages))
	for _, st := range readStatuses {
		result[st.MessageID] = append(result[st.MessageID], st.UserID)
	}

	return result, nil
}

// GetMessageDeliveryStatuses returns delivery status for messages sent by a user.
// For each message, returns the highest status achieved:
// - "sent" if no delivery records exist
// - "delivered" if at least one recipient has delivered status
// - "read" if at least one recipient has read status
// Returns map[messageID]status.
func (s *Store) GetMessageDeliveryStatuses(ctx context.Context, messageIDs []string, senderID string) (map[string]string, error) {
	if len(messageIDs) == 0 {
		return map[string]string{}, nil
	}

	// Find messages sent by the sender
	var sentMessages []*model.Message
	for start := 0; start < len(messageIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(messageIDs))

		var chunk []*model.Message
		if err := s.db.WithContext(ctx).
			Where("id IN ? AND from_id = ?", messageIDs[start:end], senderID).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		sentMessages = append(sentMessages, chunk...)
	}

	if len(sentMessages) == 0 {
		return map[string]string{}, nil
	}

	sentIDs := make([]string, len(sentMessages))
	for i, m := range sentMessages {
		sentIDs[i] = m.ID
	}

	// Get all delivery statuses for those messages (excluding the sender)
	var readStatuses []model.MessageReadStatus
	for start := 0; start < len(sentIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(sentIDs))

		var chunk []model.MessageReadStatus
		if err := s.db.WithContext(ctx).
			Where(colMessageID+" IN ? AND "+colUserID+" != ?", sentIDs[start:end], senderID).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		readStatuses = append(readStatuses, chunk...)
	}

	// Calculate highest status per message
	result := make(map[string]string, len(sentMessages))

	// Initialize all as "sent"
	for _, id := range sentIDs {
		result[id] = "sent"
	}

	// Upgrade based on statuses
	for _, st := range readStatuses {
		current := result[st.MessageID]
		if st.Status == statusRead {
			result[st.MessageID] = statusRead
		} else if st.Status == statusDelivered && current != statusRead {
			result[st.MessageID] = statusDelivered
		}
	}

	return result, nil
}

// GetMessageReaders returns the list of user IDs who read a specific message.
// Used for showing who read a message in group chats.
func (s *Store) GetMessageReaders(ctx context.Context, messageID string, limit int) ([]string, error) {
	var readers []string
	if err := s.db.WithContext(ctx).
		Model(&model.MessageReadStatus{}).
		Where(colMessageID+" = ? AND "+colStatus+" = ?", messageID, statusRead).
		Order(colReadAt+" ASC").
		Limit(limit).
		Pluck(colUserID, &readers).Error; err != nil {
		return nil, err
	}

	return readers, nil
}

// GetMessagesByIDs returns messages by their IDs filtered by chat ID.
// Used to verify message ownership before marking as read.
func (s *Store) GetMessagesByIDs(ctx context.Context, messageIDs []string, chatID string) ([]model.Message, error) {
	if len(messageIDs) == 0 {
		return []model.Message{}, nil
	}

	var messages []model.Message
	for start := 0; start < len(messageIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(messageIDs))

		var chunk []model.Message
		if err := s.db.WithContext(ctx).
			Where("id IN ? AND chat_id = ?", messageIDs[start:end], chatID).
			Find(&chunk).Error; err != nil {
			return nil, err
		}

		messages = append(messages, chunk...)
	}

	return messages, nil
}
