package store

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

const (
	fieldText     = "text"
	fieldEditedAt = "edited_at"
)

var (
	ErrMessageNotFound = errors.New("message not found")
	ErrNotYourMessage  = errors.New("not your message")
)

func (s *Store) GetMessage(chatID, messageID string) (model.Message, error) {
	var msg model.Message

	if err := s.db.Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return model.Message{}, ErrMessageNotFound
	}

	return msg, nil
}

func (s *Store) EditMessage(chatID, messageID, userID, newText string, location *model.Location, clearLocation bool) (model.Message, error) {
	var msg model.Message

	if err := s.db.Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return model.Message{}, ErrMessageNotFound
	}

	if msg.FromID != userID {
		return model.Message{}, ErrNotYourMessage
	}

	now := time.Now()
	msg.Text = newText
	msg.EditedAt = &now

	updates := map[string]interface{}{
		fieldText:     newText,
		fieldEditedAt: &now,
	}

	switch {
	case clearLocation:
		updates["location"] = nil
		msg.Location = nil

	case location != nil:
		raw, err := json.Marshal(location)
		if err != nil {
			return model.Message{}, err
		}

		updates["location"] = string(raw)
		msg.Location = location
	}

	if err := s.db.Model(&model.Message{}).Where("chat_id = ? AND id = ?", chatID, messageID).Updates(updates).Error; err != nil {
		return model.Message{}, err
	}

	return msg, nil
}

func (s *Store) SetMessageFiles(messageID string, fileIDs []string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("message_id = ?", messageID).Delete(&model.MessageFile{}).Error; err != nil {
			return err
		}

		if len(fileIDs) == 0 {
			return nil
		}

		rows := make([]model.MessageFile, 0, len(fileIDs))
		for _, fid := range fileIDs {
			rows = append(rows, model.MessageFile{MessageID: messageID, FileID: fid})
		}

		return tx.Create(&rows).Error
	})
}

func (s *Store) AddMessage(chatID, fromID, fromNick, text, messageID, replyToID string, location *model.Location) (*model.Message, error) {
	var chatCount int64
	s.db.Model(&model.Chat{}).Where("id = ?", chatID).Count(&chatCount)

	if chatCount == 0 {
		return nil, ErrChatNotFound
	}

	var replyTo *model.ReplyToInfo

	if replyToID != "" {
		var replyMsg model.Message

		if err := s.db.Where("chat_id = ? AND id = ?", chatID, replyToID).First(&replyMsg).Error; err != nil {
			return nil, ErrMessageNotFound
		}

		replyTo = &model.ReplyToInfo{
			MessageID: replyToID,
			Text:      replyMsg.Text,
			FromNick:  replyMsg.FromNick,
			Files:     s.GetMessageFilesForReply(replyMsg.ID),
			Location:  replyMsg.Location,
		}
	}

	id := messageID
	if id == "" {
		id = generateID()
	}

	msg := model.Message{
		ID:        id,
		ChatID:    chatID,
		FromID:    fromID,
		FromNick:  fromNick,
		Text:      text,
		CreatedAt: time.Now(),
		ReplyTo:   replyTo,
		Location:  location,
	}

	if err := s.db.Create(&msg).Error; err != nil {
		return nil, err
	}

	return &msg, nil
}

func (s *Store) AddRawMessage(msg *model.Message) error {
	var count int64
	s.db.Model(&model.Chat{}).Where("id = ?", msg.ChatID).Count(&count)

	if count == 0 {
		return ErrChatNotFound
	}

	// Idempotent insert: if a row with the same primary key already
	// exists (e.g. a federated message replayed by a retrying client),
	// silently succeed rather than failing the whole request.
	return s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(msg).Error
}

func (s *Store) GetMessages(chatID string) []model.Message {
	var msgs []model.Message

	s.db.Where("chat_id = ?", chatID).Order("created_at ASC, id ASC").Find(&msgs)

	return msgs
}

func (s *Store) GetMessagesPaginated(chatID string, limit int, before string) ([]model.Message, string, bool) {
	return s.paginateMessages(chatID, limit, before)
}

func (s *Store) DeleteMessage(chatID, messageID, userID string) error {
	var msg model.Message

	if err := s.db.Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return ErrMessageNotFound
	}

	if msg.FromID != userID {
		return ErrNotYourMessage
	}

	return s.db.Where("chat_id = ? AND id = ?", chatID, messageID).Delete(&model.Message{}).Error
}

func (s *Store) EditRawMessage(chatID, messageID, text string, editedAt time.Time, location *model.Location, clearLocation bool) error {
	updates := map[string]interface{}{
		fieldText:     text,
		fieldEditedAt: &editedAt,
	}

	if clearLocation {
		updates["location"] = nil
	} else if location != nil {
		raw, err := json.Marshal(location)
		if err != nil {
			return err
		}

		updates["location"] = string(raw)
	}

	result := s.db.Model(&model.Message{}).Where("chat_id = ? AND id = ?", chatID, messageID).Updates(updates)

	if result.RowsAffected == 0 {
		return ErrMessageNotFound
	}

	return result.Error
}

func (s *Store) DeleteRawMessage(chatID, messageID string) error {
	result := s.db.Where("chat_id = ? AND id = ?", chatID, messageID).Delete(&model.Message{})

	if result.RowsAffected == 0 {
		return ErrMessageNotFound
	}

	return result.Error
}

func (s *Store) paginateMessages(chatID string, limit int, before string) ([]model.Message, string, bool) {
	query := s.db.Where("chat_id = ?", chatID)

	if before != "" {
		var beforeMsg struct {
			CreatedAt time.Time
		}

		if err := s.db.Model(&model.Message{}).
			Select("created_at").
			Where("id = ?", before).
			First(&beforeMsg).Error; err != nil {
			return nil, "", false
		}

		query = query.Where("(created_at < ? OR (created_at = ? AND id < ?))",
			beforeMsg.CreatedAt, beforeMsg.CreatedAt, before)
	}

	// Fetch limit+1 in one query and use the extra row as a hasMore
	// signal — saves a separate COUNT round-trip per page.
	var msgs []model.Message

	if err := query.Order("created_at DESC, id DESC").Limit(limit + 1).Find(&msgs).Error; err != nil {
		return nil, "", false
	}

	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}

	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	if len(msgs) == 0 {
		return nil, "", false
	}

	nextCursor := ""

	if hasMore {
		nextCursor = msgs[0].ID
	}

	return msgs, nextCursor, hasMore
}
