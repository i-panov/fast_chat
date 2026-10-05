package store

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

const (
	fieldText      = "text"
	fieldCreatedAt = "created_at"
	fieldEditedAt  = "edited_at"
	fieldUpdatedAt = "updated_at"
)

var (
	ErrMessageNotFound = errors.New("message not found")
	ErrNotYourMessage  = errors.New("not your message")
)

func (s *Store) GetMessage(ctx context.Context, chatID, messageID string) (model.Message, error) {
	var msg model.Message

	if err := s.db.WithContext(ctx).Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return model.Message{}, ErrMessageNotFound
	}

	return msg, nil
}

func (s *Store) EditMessage(
	ctx context.Context,
	chatID, threadID, messageID, userID, newText string,
	location *model.Location,
	clearLocation bool,
	encrypted *bool,
	encryptedPayload *string,
) (model.Message, error) {

	if threadID != "" {
		var thread model.Thread

		if err := s.db.WithContext(ctx).First(&thread, "id = ?", threadID).Error; err != nil {
			return model.Message{}, ErrThreadNotFound
		}

		if thread.ChatID != chatID {
			return model.Message{}, ErrThreadNotFound
		}
	}

	var msg model.Message

	if err := s.db.WithContext(ctx).Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return model.Message{}, ErrMessageNotFound
	}

	if msg.FromID != userID {
		return model.Message{}, ErrNotYourMessage
	}

	now := time.Now().UTC()
	msg.Text = newText
	msg.EditedAt = &now
	msg.UpdatedAt = now

	updates := map[string]any{
		fieldText:      newText,
		fieldEditedAt:  &now,
		fieldUpdatedAt: now,
	}

	// Patch semantics: only update encryption fields when the client
	// explicitly sent them. Otherwise a location-only edit would wipe
	// the ciphertext of an encrypted message.
	if encrypted != nil {
		msg.Encrypted = *encrypted
		updates["encrypted"] = *encrypted
	}
	if encryptedPayload != nil {
		msg.EncryptedPayload = *encryptedPayload
		updates["encrypted_payload"] = *encryptedPayload
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

	if err := s.db.WithContext(ctx).Model(&model.Message{}).Where("chat_id = ? AND id = ?", chatID, messageID).Updates(updates).Error; err != nil {
		return model.Message{}, err
	}

	return msg, nil
}

// threadIDIsEmpty matches rows that are not thread messages.
//
// NULL counts as chat level on purpose: a row whose thread_id was never
// populated must still appear in the chat feed and in the sync delta, so
// comparing against the empty string alone is not safe here.
const threadIDIsEmpty = "(thread_id = '' OR thread_id IS NULL)"

// messageScope is the predicate selecting the messages of one container: a
// chat's top-level messages, or the messages of a single thread.
type messageScope struct {
	where string
	args  []any
}

// chatScope selects the top-level messages of a chat.
//
// thread_id must be excluded explicitly: chat_id now always names the chat,
// so without this filter every thread message would also show up in the chat
// feed and in the chat message list.
func chatScope(chatID string) messageScope {
	return messageScope{where: "chat_id = ? AND " + threadIDIsEmpty, args: []any{chatID}}
}

// threadScope selects the messages of one thread.
func threadScope(threadID string) messageScope {
	return messageScope{where: "thread_id = ?", args: []any{threadID}}
}

// and returns a new scope narrowed by an extra condition. args is copied so a
// later append can never write into an array another query is still reading
// from, which a bare append(scope.args, ...) would allow whenever the backing
// array had spare capacity.
func (s messageScope) and(cond string, args ...any) messageScope {
	nested := make([]any, 0, len(s.args)+len(args))
	nested = append(nested, s.args...)
	nested = append(nested, args...)

	return messageScope{where: s.where + " AND " + cond, args: nested}
}

func (s *Store) SetMessageFiles(ctx context.Context, messageID string, fileIDs []string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
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

func (s *Store) AddMessage(
	ctx context.Context,
	chatID, threadID, fromID, fromNick, text, messageID, replyToID string,
	location *model.Location,
	encrypted bool,
	encryptedPayload string,
) (*model.Message, error) {

	// The thread must exist and belong to this chat, so a thread id from
	// another chat cannot be used to write into it.
	scope := chatScope(chatID)

	if threadID != "" {
		var thread model.Thread

		if err := s.db.WithContext(ctx).First(&thread, "id = ?", threadID).Error; err != nil {
			return nil, ErrThreadNotFound
		}

		if thread.ChatID != chatID {
			return nil, ErrThreadNotFound
		}

		scope = threadScope(threadID)
	} else {
		var chatCount int64
		s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chatID).Count(&chatCount)

		if chatCount == 0 {
			return nil, ErrChatNotFound
		}
	}

	var replyTo *model.ReplyToInfo

	if replyToID != "" {
		var replyMsg model.Message

		target := scope.and("id = ?", replyToID)

		if err := s.db.WithContext(ctx).Where(target.where, target.args...).First(&replyMsg).Error; err != nil {
			return nil, ErrMessageNotFound
		}

		replyTo = &model.ReplyToInfo{
			MessageID: replyToID,
			Text:      replyMsg.Text,
			FromNick:  replyMsg.FromNick,
			Files:     s.GetMessageFilesForReply(ctx, replyMsg.ID),
			Location:  replyMsg.Location,
		}
	}

	id := messageID
	if id == "" {
		id = GenerateID()
	}

	now := time.Now().UTC()
	msg := model.Message{
		ID:               id,
		ChatID:           chatID,
		ThreadID:         threadID,
		FromID:           fromID,
		FromNick:         fromNick,
		Text:             text,
		Encrypted:        encrypted,
		EncryptedPayload: encryptedPayload,
		CreatedAt:        now,
		UpdatedAt:        now,
		ReplyTo:          replyTo,
		Location:         location,
	}

	// Idempotent insert: if a row with the same primary key already
	// exists (e.g. a retried send from the offline outbox), silently
	// succeed rather than failing the whole request.
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&msg).Error; err != nil {
		return nil, err
	}

	if threadID != "" {
		if err := s.db.WithContext(ctx).Model(&model.Thread{}).Where("id = ?", threadID).
			UpdateColumn("message_count", gorm.Expr("message_count + 1")).Error; err != nil {
			slog.Warn("failed to update thread message_count", "threadID", threadID, "err", err)
		}
	}

	return &msg, nil
}

// AddRawMessage inserts a message the caller built itself. It is the write
// path used by the federation receiver, which assembles the row from the wire
// payload; the only fields it may not choose freely are the ones this store
// owns, so the chat and the thread are validated here rather than trusted.
// A non-empty ThreadID must exist and belong to ChatID.
func (s *Store) AddRawMessage(ctx context.Context, msg *model.Message) error {
	var count int64
	s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", msg.ChatID).Count(&count)

	if count == 0 {
		return ErrChatNotFound
	}

	if msg.ThreadID != "" {
		var thread model.Thread

		if err := s.db.WithContext(ctx).First(&thread, "id = ?", msg.ThreadID).Error; err != nil {
			return ErrThreadNotFound
		}

		if thread.ChatID != msg.ChatID {
			return ErrThreadNotFound
		}
	}

	// Callers on the federation path build the message themselves, leaving the
	// timestamps to be auto-filled. Stamp them explicitly anyway: GORM's
	// auto-tracking is bypassed as soon as the field carries a `default:` tag
	// (see model.Message), which would store a frozen instant and hide the
	// message from the sync delta.
	now := time.Now().UTC()
	if msg.CreatedAt.IsZero() {
		msg.CreatedAt = now
	}

	if msg.UpdatedAt.IsZero() {
		msg.UpdatedAt = msg.CreatedAt
	}

	// Idempotent insert: if a row with the same primary key already
	// exists (e.g. a federated message replayed by a retrying client),
	// silently succeed rather than failing the whole request.
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(msg).Error
}

func (s *Store) GetMessagesPaginated(ctx context.Context, chatID string, limit int, before string) ([]model.Message, string, bool) {
	return s.paginateMessages(ctx, chatScope(chatID), limit, before)
}

func (s *Store) DeleteMessage(ctx context.Context, chatID, messageID, userID string) error {
	var msg model.Message

	if err := s.db.WithContext(ctx).Where("chat_id = ? AND id = ?", chatID, messageID).First(&msg).Error; err != nil {
		return ErrMessageNotFound
	}

	if msg.FromID != userID {
		return ErrNotYourMessage
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("chat_id = ? AND id = ?", chatID, messageID).Delete(&model.Message{}).Error; err != nil {
			return err
		}

		// Tombstone: lets the /api/sync delta tell offline clients
		// that this message was removed. Upsert in case a previous
		// delete was retried and the tombstone already exists.
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.DeletedMessage{
			ChatID:    chatID,
			MessageID: messageID,
			DeletedAt: time.Now().UTC(),
		}).Error
	})
}

func (s *Store) EditRawMessage(
	ctx context.Context,
	chatID, messageID, text string,
	editedAt time.Time,
	location *model.Location,
	clearLocation bool,
	encrypted *bool,
	encryptedPayload *string,
) error {

	updates := map[string]any{
		fieldText:      text,
		fieldEditedAt:  &editedAt,
		fieldUpdatedAt: editedAt,
	}

	// Patch semantics: only update encryption fields when present.
	if encrypted != nil {
		updates["encrypted"] = *encrypted
	}
	if encryptedPayload != nil {
		updates["encrypted_payload"] = *encryptedPayload
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

	result := s.db.WithContext(ctx).Model(&model.Message{}).Where("chat_id = ? AND id = ?", chatID, messageID).Updates(updates)

	if result.RowsAffected == 0 {
		return ErrMessageNotFound
	}

	return result.Error
}

func (s *Store) DeleteRawMessage(ctx context.Context, chatID, messageID string) error {
	now := time.Now().UTC()

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Where("chat_id = ? AND id = ?", chatID, messageID).Delete(&model.Message{})
		if result.RowsAffected == 0 {
			return ErrMessageNotFound
		}

		if err := result.Error; err != nil {
			return err
		}

		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.DeletedMessage{
			ChatID:    chatID,
			MessageID: messageID,
			DeletedAt: now,
		}).Error
	})
}

func (s *Store) paginateMessages(ctx context.Context, scope messageScope, limit int, before string) ([]model.Message, string, bool) {
	query := s.db.WithContext(ctx).Where(scope.where, scope.args...)

	if before != "" {
		var beforeMsg struct {
			CreatedAt time.Time
		}

		// The cursor row must belong to the same container, otherwise a
		// client could page past the end of a chat using an id from elsewhere.
		cursorScope := scope.and("id = ?", before)

		if err := s.db.WithContext(ctx).Model(&model.Message{}).
			Select(fieldCreatedAt).
			Where(cursorScope.where, cursorScope.args...).
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
