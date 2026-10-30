package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

var (
	ErrThreadNotFound = errors.New("thread not found")
	ErrThreadExists   = errors.New("thread already exists for this message")
)

func (s *Store) CreateThread(ctx context.Context, chatID, parentMessageID, parentText, parentFrom string) (*model.Thread, error) {
	if parentMessageID == "" {
		return nil, ErrMessageNotFound
	}

	var chatCount int64
	if err := s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chatID).Count(&chatCount).Error; err != nil {
		return nil, err
	}

	if chatCount == 0 {
		return nil, ErrChatNotFound
	}

	// The parent must be a message of the same chat: without this a thread
	// can point at a missing row or at a message from another chat.
	var parentCount int64
	if err := s.db.WithContext(ctx).Model(&model.Message{}).
		Where("id = ? AND chat_id = ?", parentMessageID, chatID).
		Count(&parentCount).Error; err != nil {
		return nil, err
	}

	if parentCount == 0 {
		return nil, ErrMessageNotFound
	}

	var existing int64
	if err := s.db.WithContext(ctx).Model(&model.Thread{}).
		Where("chat_id = ? AND parent_message_id = ?", chatID, parentMessageID).
		Count(&existing).Error; err != nil {
		return nil, err
	}

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
		CreatedAt:         time.Now().UTC(),
	}

	// The unique index on (chat_id, parent_message_id) makes the check
	// above safe under concurrency: the loser of a race hits the
	// constraint instead of creating a second thread.
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(thread).Error; err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, ErrThreadExists
		}

		return nil, err
	}

	// OnConflict DoNothing reports success with zero rows on a conflict
	// when the index exists; without the index the pre-check above is the
	// guard. Re-read to distinguish the two.
	var check model.Thread
	if err := s.db.WithContext(ctx).First(&check, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrThreadExists
		}

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
	return s.paginateMessages(ctx, threadScope(threadID), limit, before)
}

// GetThreadMessagesPaginatedE reports database failures to the caller.
func (s *Store) GetThreadMessagesPaginatedE(ctx context.Context, threadID string, limit int, before string) ([]model.Message, string, bool, error) {
	return s.paginateMessagesE(ctx, threadScope(threadID), limit, before)
}
