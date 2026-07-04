package store

import (
	"context"
	"errors"
	"time"

	"fast_chat/model"
)

var (
	ErrThreadNotFound = errors.New("thread not found")
	ErrThreadExists   = errors.New("thread already exists for this message")
)

func (s *Store) CreateThread(ctx context.Context, chatID, parentMessageID, parentText, parentFrom string) (*model.Thread, error) {
	var chatCount int64
	s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chatID).Count(&chatCount)

	if chatCount == 0 {
		return nil, ErrChatNotFound
	}

	var existing int64
	s.db.WithContext(ctx).Model(&model.Thread{}).
		Where("chat_id = ? AND parent_message_id = ?", chatID, parentMessageID).
		Count(&existing)

	if existing > 0 {
		return nil, ErrThreadExists
	}

	id := GenerateID()
	thread := &model.Thread{
		ID:                id,
		ChatID:            chatID,
		ParentMessageID:   parentMessageID,
		ParentMessageText: parentText,
		ParentMessageFrom: parentFrom,
		CreatedAt:         time.Now(),
	}

	if err := s.db.WithContext(ctx).Create(thread).Error; err != nil {
		return nil, err
	}

	return thread, nil
}

func (s *Store) GetThread(ctx context.Context, threadID string) (model.Thread, bool) {
	var thread model.Thread

	if err := s.db.WithContext(ctx).First(&thread, "id = ?", threadID).Error; err != nil {
		return model.Thread{}, false
	}

	return thread, true
}

func (s *Store) GetThreadByParentMessage(ctx context.Context, chatID, parentMessageID string) (model.Thread, bool) {
	var thread model.Thread

	if err := s.db.WithContext(ctx).Where("chat_id = ? AND parent_message_id = ?", chatID, parentMessageID).First(&thread).Error; err != nil {
		return model.Thread{}, false
	}

	return thread, true
}

func (s *Store) GetThreadsForChat(ctx context.Context, chatID string) []model.Thread {
	var threads []model.Thread

	s.db.WithContext(ctx).Where("chat_id = ?", chatID).Order("created_at ASC").Find(&threads)

	return threads
}

func (s *Store) GetThreadMessagesPaginated(ctx context.Context, threadID string, limit int, before string) ([]model.Message, string, bool) {
	return s.paginateMessages(ctx, threadID, limit, before)
}
