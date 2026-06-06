package store

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

var (
	ErrThreadNotFound = errors.New("thread not found")
	ErrThreadExists   = errors.New("thread already exists for this message")
)

func (s *Store) CreateThread(chatID, parentMessageID, parentText, parentFrom string) (*model.Thread, error) {
	var chatCount int64
	s.db.Model(&model.Chat{}).Where("id = ?", chatID).Count(&chatCount)

	if chatCount == 0 {
		return nil, ErrChatNotFound
	}

	var existing int64
	s.db.Model(&model.Thread{}).
		Where("chat_id = ? AND parent_message_id = ?", chatID, parentMessageID).
		Count(&existing)

	if existing > 0 {
		return nil, ErrThreadExists
	}

	id := generateID()
	thread := &model.Thread{
		ID:                id,
		ChatID:            chatID,
		ParentMessageID:   parentMessageID,
		ParentMessageText: parentText,
		ParentMessageFrom: parentFrom,
		CreatedAt:         time.Now(),
	}

	if err := s.db.Create(thread).Error; err != nil {
		return nil, err
	}

	return thread, nil
}

func (s *Store) GetThread(threadID string) (model.Thread, bool) {
	var thread model.Thread

	if err := s.db.First(&thread, "id = ?", threadID).Error; err != nil {
		return model.Thread{}, false
	}

	return thread, true
}

func (s *Store) GetThreadByParentMessage(chatID, parentMessageID string) (model.Thread, bool) {
	var thread model.Thread

	if err := s.db.Where("chat_id = ? AND parent_message_id = ?", chatID, parentMessageID).First(&thread).Error; err != nil {
		return model.Thread{}, false
	}

	return thread, true
}

func (s *Store) GetThreadsForChat(chatID string) []model.Thread {
	var threads []model.Thread

	s.db.Where("chat_id = ?", chatID).Order("created_at ASC").Find(&threads)

	return threads
}

func (s *Store) GetThreadMessagesPaginated(threadID string, limit int, before string) ([]model.Message, string, bool) {
	return s.paginateMessages(threadID, limit, before)
}

func (s *Store) AddThreadMessage(threadID, fromID, fromNick, text, messageID, replyToID string, location *model.Location) (*model.Message, error) {
	var thread model.Thread

	if err := s.db.First(&thread, "id = ?", threadID).Error; err != nil {
		return nil, ErrThreadNotFound
	}

	var replyTo *model.ReplyToInfo

	if replyToID != "" {
		var replyMsg model.Message

		if err := s.db.Where("chat_id = ? AND id = ?", threadID, replyToID).First(&replyMsg).Error; err != nil {
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
		ChatID:    threadID,
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

	s.db.Model(&model.Thread{}).Where("id = ?", threadID).
		UpdateColumn("message_count", gorm.Expr("message_count + 1"))

	return &msg, nil
}

func (s *Store) EditThreadMessage(threadID, messageID, userID, newText string, location *model.Location, clearLocation bool) (model.Message, error) {
	var thread model.Thread

	if err := s.db.First(&thread, "id = ?", threadID).Error; err != nil {
		return model.Message{}, ErrThreadNotFound
	}

	var msg model.Message

	if err := s.db.Where("chat_id = ? AND id = ?", threadID, messageID).First(&msg).Error; err != nil {
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

	if err := s.db.Model(&model.Message{}).Where("chat_id = ? AND id = ?", threadID, messageID).Updates(updates).Error; err != nil {
		return model.Message{}, err
	}

	return msg, nil
}
