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

// MarkMessagesRead marks messages as read for a user. Uses upsert to
// handle the case where a status already exists (e.g. delivered -> read).
func (s *Store) MarkMessagesRead(ctx context.Context, messageIDs []string, userID string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	now := time.Now()
	statuses := make([]model.MessageReadStatus, 0, len(messageIDs))

	for _, msgID := range messageIDs {
		statuses = append(statuses, model.MessageReadStatus{
			MessageID: msgID,
			UserID:    userID,
			Status:    statusRead,
			ReadAt:    now,
		})
	}

	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: colMessageID}, {Name: colUserID}},
		DoUpdates: clause.AssignmentColumns([]string{colStatus, colReadAt}),
	}).Create(&statuses).Error
}

// MarkMessagesDelivered marks messages as delivered for a user. Uses upsert
// but does not overwrite "read" status (read is higher priority than delivered).
func (s *Store) MarkMessagesDelivered(ctx context.Context, messageIDs []string, userID string) error {
	if len(messageIDs) == 0 {
		return nil
	}

	now := time.Now()
	statuses := make([]model.MessageReadStatus, 0, len(messageIDs))

	for _, msgID := range messageIDs {
		statuses = append(statuses, model.MessageReadStatus{
			MessageID: msgID,
			UserID:    userID,
			Status:    statusDelivered,
			ReadAt:    now,
		})
	}

	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: colMessageID}, {Name: colUserID}},
		DoUpdates: clause.Assignments(map[string]any{
			colStatus: gorm.Expr("CASE WHEN " + colStatus + " = '" + statusRead + "' THEN '" + statusRead + "' ELSE '" + statusDelivered + "' END"),
			colReadAt: gorm.Expr("CASE WHEN "+colStatus+" = '"+statusRead+"' THEN "+colReadAt+" ELSE ? END", now),
		}),
	}).Create(&statuses).Error
}

// GetMessageReadStatusesBatch returns read statuses for a user for the given messages.
// Returns map[messageID]status.
func (s *Store) GetMessageReadStatusesBatch(ctx context.Context, messageIDs []string, userID string) (map[string]string, error) {
	if len(messageIDs) == 0 {
		return map[string]string{}, nil
	}

	var statuses []model.MessageReadStatus
	if err := s.db.WithContext(ctx).
		Where(colMessageID+" IN ? AND "+colUserID+" = ?", messageIDs, userID).
		Find(&statuses).Error; err != nil {
		return nil, err
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
	if err := s.db.WithContext(ctx).
		Where("id IN ? AND from_id = ?", messageIDs, senderID).
		Find(&sentMessages).Error; err != nil {
		return nil, err
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
	if err := s.db.WithContext(ctx).
		Where(colMessageID+" IN ? AND "+colUserID+" != ? AND "+colStatus+" = '"+statusRead+"'", sentIDs, senderID).
		Find(&readStatuses).Error; err != nil {
		return nil, err
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
	if err := s.db.WithContext(ctx).
		Where("id IN ? AND from_id = ?", messageIDs, senderID).
		Find(&sentMessages).Error; err != nil {
		return nil, err
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
	if err := s.db.WithContext(ctx).
		Where(colMessageID+" IN ? AND "+colUserID+" != ?", sentIDs, senderID).
		Find(&readStatuses).Error; err != nil {
		return nil, err
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
		Where(colMessageID+" = ? AND "+colStatus+" = '"+statusRead+"'", messageID).
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
	if err := s.db.WithContext(ctx).
		Where("id IN ? AND chat_id = ?", messageIDs, chatID).
		Find(&messages).Error; err != nil {
		return nil, err
	}

	return messages, nil
}
