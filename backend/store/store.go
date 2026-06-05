// Package store provides data persistence using SQLite via GORM.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

const (
	chatTypePrivate = "private"
	chatTypeGroup   = "group"
	fieldText       = "text"
	fieldEditedAt   = "edited_at"
)

var (
	ErrChatNotFound    = errors.New("chat not found")
	ErrMessageNotFound = errors.New("message not found")
	ErrNotYourMessage  = errors.New("not your message")
	ErrThreadNotFound  = errors.New("thread not found")
	ErrThreadExists    = errors.New("thread already exists for this message")
	ErrNicknameTaken   = errors.New("nickname already taken")
	ErrFileNotFound    = errors.New("file not found")
)

func generateID() string {
	buf := make([]byte, 16)

	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand.Read failed: " + err.Error())
	}

	return hex.EncodeToString(buf)
}

type Store struct {
	db     *gorm.DB
	connMu sync.Mutex
	conns  map[string]int
}

func New(db *gorm.DB) *Store {
	return &Store{
		db:    db,
		conns: make(map[string]int),
	}
}

func (s *Store) DB() *gorm.DB {
	return s.db
}

func (s *Store) CreateUser(fullID, nick string) (*model.User, error) {
	var existing int64
	s.db.Model(&model.User{}).Where("id = ?", fullID).Count(&existing)

	if existing > 0 {
		return nil, ErrNicknameTaken
	}

	user := &model.User{
		ID:     fullID,
		Nick:   nick,
		Token:  generateID(),
		Online: true,
	}

	if err := s.db.Create(user).Error; err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, ErrNicknameTaken
		}

		return nil, err
	}

	return user, nil
}

func (s *Store) GetUserByToken(token string) (*model.User, bool) {
	var user model.User

	if err := s.db.Where("token = ?", token).First(&user).Error; err != nil {
		return nil, false
	}

	return &user, true
}

func (s *Store) GetUserByID(id string) (*model.User, bool) {
	var user model.User

	if err := s.db.First(&user, "id = ?", id).Error; err != nil {
		return nil, false
	}

	return &user, true
}

func (s *Store) SearchUsers(query, excludeID string) []model.User {
	q := strings.ToLower(query)

	var users []model.User

	s.db.Where("LOWER(nick) LIKE ? AND id != ?", "%"+q+"%", excludeID).Find(&users)

	if users == nil {
		return []model.User{}
	}

	return users
}

func (s *Store) CreateChat(member1, member2 string) (*model.Chat, error) {
	var chatIDs []string

	s.db.Model(&ChatMember{}).
		Select("chat_id").
		Where("user_id IN ?", []string{member1, member2}).
		Group("chat_id").
		Having("COUNT(DISTINCT user_id) = 2").
		Pluck("chat_id", &chatIDs)

	if len(chatIDs) > 0 {
		var chat model.Chat

		chatIDQuery := s.db.Model(&model.Chat{}).
			Select("id").
			Where("id IN ? AND type = ?", chatIDs, chatTypePrivate)

		var foundID string
		if err := chatIDQuery.Limit(1).Row().Scan(&foundID); err == nil {
			if err := s.db.First(&chat, "id = ?", foundID).Error; err == nil {
				chat.Members = []string{member1, member2}

				return &chat, nil
			}
		}
	}

	id := generateID()
	chat := &model.Chat{
		ID:        id,
		Type:      chatTypePrivate,
		CreatedAt: time.Now(),
	}

	if err := s.db.Create(chat).Error; err != nil {
		return nil, err
	}

	members := []ChatMember{
		{ChatID: id, UserID: member1},
		{ChatID: id, UserID: member2},
	}

	if err := s.db.Create(&members).Error; err != nil {
		return nil, err
	}

	chat.Members = []string{member1, member2}

	return chat, nil
}

func (s *Store) CreateGroupChat(name, ownerID string, memberIDs []string) (*model.Chat, error) {
	seen := make(map[string]struct{}, len(memberIDs)+1)
	dedup := make([]string, 0, len(memberIDs)+1)
	add := func(id string) {
		if id == "" {
			return
		}

		if _, ok := seen[id]; ok {
			return
		}

		seen[id] = struct{}{}
		dedup = append(dedup, id)
	}

	add(ownerID)

	for _, m := range memberIDs {
		add(m)
	}

	if len(dedup) < 1 {
		return nil, errors.New("group chat must have at least one member (the owner)")
	}

	id := generateID()
	chat := &model.Chat{
		ID:        id,
		Type:      chatTypeGroup,
		Name:      name,
		OwnerID:   ownerID,
		CreatedAt: time.Now(),
	}

	if err := s.db.Create(chat).Error; err != nil {
		return nil, err
	}

	members := make([]ChatMember, 0, len(dedup))
	for _, m := range dedup {
		members = append(members, ChatMember{ChatID: id, UserID: m})
	}

	if err := s.db.Create(&members).Error; err != nil {
		return nil, err
	}

	chat.Members = dedup

	return chat, nil
}

func (s *Store) AddChatMember(chatID, userID string) error {
	chat, ok := s.GetChat(chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return errors.New("cannot add members to non-group chat")
	}

	for _, m := range chat.Members {
		if m == userID {
			return nil //nolint:nilerr // already a member is a no-op
		}
	}

	return s.db.Create(&ChatMember{ChatID: chatID, UserID: userID}).Error
}

func (s *Store) RemoveChatMember(chatID, userID string) error {
	chat, ok := s.GetChat(chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return errors.New("cannot remove members from non-group chat")
	}

	if len(chat.Members) <= 1 {
		return errors.New("cannot remove the last member")
	}

	return s.db.Where("chat_id = ? AND user_id = ?", chatID, userID).Delete(&ChatMember{}).Error
}

func (s *Store) UpdateChatName(chatID, name string) (*model.Chat, error) {
	chat, ok := s.GetChat(chatID)
	if !ok {
		return nil, ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return nil, errors.New("cannot rename non-group chat")
	}

	if err := s.db.Model(&model.Chat{}).Where("id = ?", chatID).Update("name", name).Error; err != nil {
		return nil, err
	}

	chat.Name = name

	return chat, nil
}

func (s *Store) UpdateChatAvatar(chatID, fileID string) (*model.Chat, error) {
	chat, ok := s.GetChat(chatID)
	if !ok {
		return nil, ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return nil, errors.New("cannot set avatar on non-group chat")
	}

	if err := s.db.Model(&model.Chat{}).Where("id = ?", chatID).Update("avatar_file_id", fileID).Error; err != nil {
		return nil, err
	}

	chat.AvatarFileID = fileID

	return chat, nil
}

func (s *Store) GetChatsByAvatarFileID(fileID string) ([]string, error) {
	var chatIDs []string

	err := s.db.Model(&model.Chat{}).
		Where("avatar_file_id = ?", fileID).
		Pluck("id", &chatIDs).
		Error

	if chatIDs == nil {
		return []string{}, nil
	}

	return chatIDs, err
}

func (s *Store) DeleteChat(chatID string) error {
	chat, ok := s.GetChat(chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return errors.New("cannot delete non-group chat")
	}

	return s.db.Transaction(func(tx *gorm.DB) error {
		var msgIDs []string
		if err := tx.Model(&model.Message{}).Where("chat_id = ?", chatID).Pluck("id", &msgIDs).Error; err != nil {
			return err
		}

		if len(msgIDs) > 0 {
			if err := tx.Where("message_id IN ?", msgIDs).Delete(&model.MessageFile{}).Error; err != nil {
				return err
			}

			if err := tx.Where("chat_id = ?", chatID).Delete(&model.Message{}).Error; err != nil {
				return err
			}
		}

		if err := tx.Where("chat_id = ?", chatID).Delete(&model.Thread{}).Error; err != nil {
			return err
		}

		if err := tx.Where("chat_id = ?", chatID).Delete(&ChatMember{}).Error; err != nil {
			return err
		}

		return tx.Where("id = ?", chatID).Delete(&model.Chat{}).Error
	})
}

func (s *Store) GetUserChats(userID string) []*model.Chat {
	var chatIDs []string

	s.db.Model(&ChatMember{}).Where("user_id = ?", userID).Pluck("chat_id", &chatIDs)

	var chats []*model.Chat

	s.db.Where("id IN ?", chatIDs).Order("created_at DESC").Find(&chats)

	for _, c := range chats {
		var memberIDs []string

		s.db.Model(&ChatMember{}).Where("chat_id = ?", c.ID).Pluck("user_id", &memberIDs)
		c.Members = memberIDs
	}

	return chats
}

func (s *Store) GetChat(chatID string) (*model.Chat, bool) {
	var chat model.Chat

	if err := s.db.First(&chat, "id = ?", chatID).Error; err != nil {
		return nil, false
	}

	var members []string

	s.db.Model(&ChatMember{}).Where("chat_id = ?", chatID).Pluck("user_id", &members)
	chat.Members = members

	return &chat, true
}

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

func (s *Store) SetMessageFiles(messageID string, fileIDs []string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("message_id = ?", messageID).Delete(&model.MessageFile{}).Error; err != nil {
			return err
		}

		for _, fid := range fileIDs {
			if err := tx.Create(&model.MessageFile{MessageID: messageID, FileID: fid}).Error; err != nil {
				return fmt.Errorf("link file %s to message %s: %w", fid, messageID, err)
			}
		}

		return nil
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

	return s.db.Create(msg).Error
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

func (s *Store) CreateRemoteChat(chat *model.Chat) {
	var count int64
	s.db.Model(&model.Chat{}).Where("id = ?", chat.ID).Count(&count)

	if count > 0 {
		return
	}

	if chat.Type == "" {
		chat.Type = chatTypePrivate
	}

	s.db.Create(chat)

	members := make([]ChatMember, len(chat.Members))

	for i, m := range chat.Members {
		members[i] = ChatMember{ChatID: chat.ID, UserID: m}
	}

	s.db.Create(&members) //nolint:errcheck // best-effort member insert for remote chat
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

func (s *Store) paginateMessages(chatID string, limit int, before string) ([]model.Message, string, bool) {
	var msgs []model.Message

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

	if err := query.Order("created_at DESC, id DESC").Limit(limit).Find(&msgs).Error; err != nil {
		return nil, "", false
	}

	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	if len(msgs) == 0 {
		return nil, "", false
	}

	first := msgs[0]

	var count int64
	s.db.Model(&model.Message{}).
		Where("chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))",
			chatID, first.CreatedAt, first.CreatedAt, first.ID).
		Count(&count)

	hasMore := count > 0
	nextCursor := ""

	if hasMore {
		nextCursor = first.ID
	}

	return msgs, nextCursor, hasMore
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

func (s *Store) AddConnection(userID string) {
	s.connMu.Lock()
	s.conns[userID]++
	prev := s.conns[userID] - 1
	s.connMu.Unlock()

	if prev == 0 {
		s.db.Model(&model.User{}).Where("id = ?", userID).Update("online", true)
	}
}

func (s *Store) RemoveConnection(userID string) {
	s.connMu.Lock()
	s.conns[userID]--
	remaining := s.conns[userID]

	if remaining <= 0 {
		s.conns[userID] = 0
	}

	s.connMu.Unlock()

	if remaining == 0 {
		s.db.Model(&model.User{}).Where("id = ?", userID).Update("online", false)
	}
}

func (s *Store) SaveFile(hash, mimeType string, size int64, originalName, storagePath string) (*model.File, error) {
	existing, ok := s.FindFileByHash(hash)
	if ok {
		return existing, nil
	}

	file := &model.File{
		ID:           generateID(),
		Hash:         hash,
		MimeType:     mimeType,
		Size:         size,
		OriginalName: originalName,
		StoragePath:  storagePath,
		CreatedAt:    time.Now(),
	}

	if err := s.db.Create(file).Error; err != nil {
		return nil, err
	}

	return file, nil
}

func (s *Store) FindFileByHash(hash string) (*model.File, bool) {
	var f model.File
	if err := s.db.Where("hash = ?", hash).First(&f).Error; err != nil {
		return nil, false
	}

	return &f, true
}

func (s *Store) GetFile(fileID string) (*model.File, error) {
	var f model.File
	if err := s.db.First(&f, "id = ?", fileID).Error; err != nil {
		return nil, ErrFileNotFound
	}

	return &f, nil
}

func (s *Store) AddMessageFiles(messageID string, fileIDs []string) error {
	if len(fileIDs) == 0 {
		return nil
	}

	for _, fid := range fileIDs {
		if err := s.db.Create(&model.MessageFile{MessageID: messageID, FileID: fid}).Error; err != nil {
			return fmt.Errorf("link file %s to message %s: %w", fid, messageID, err)
		}
	}

	return nil
}

func (s *Store) GetMessageFiles(messageID string) ([]model.FileInfo, error) {
	var rows []model.MessageFile
	if err := s.db.Where("message_id = ?", messageID).Find(&rows).Error; err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		return nil, nil
	}

	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.FileID
	}

	var files []model.File
	if err := s.db.Where("id IN ?", ids).Find(&files).Error; err != nil {
		return nil, err
	}

	result := make([]model.FileInfo, len(files))
	for i, f := range files {
		result[i] = f.ToFileInfo()
	}

	return result, nil
}

// GetMessageFilesForReply returns files for embedding into a ReplyToInfo.
// It silently swallows errors and returns nil on failure to keep the caller paths simple.
func (s *Store) GetMessageFilesForReply(messageID string) []model.FileInfo {
	files, err := s.GetMessageFiles(messageID)
	if err != nil {
		return nil
	}

	return files
}

func (s *Store) GetFileChats(fileID string) ([]string, error) {
	var rows []model.MessageFile
	if err := s.db.Where("file_id = ?", fileID).Find(&rows).Error; err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		return nil, nil
	}

	msgIDs := make([]string, len(rows))
	for i, r := range rows {
		msgIDs[i] = r.MessageID
	}

	var msgs []model.Message
	if err := s.db.Where("id IN ?", msgIDs).Find(&msgs).Error; err != nil {
		return nil, err
	}

	seen := make(map[string]struct{})

	var chatIDs []string

	for idx := range msgs {
		cid := msgs[idx].ChatID

		if _, ok := seen[cid]; !ok {
			seen[cid] = struct{}{}
			chatIDs = append(chatIDs, cid)
		}
	}

	return chatIDs, nil
}

// Close marks all users offline and closes the database connection.
func (s *Store) Close() {
	s.db.Model(&model.User{}).Where("1 = 1").Update("online", false)

	sqlDB, err := s.db.DB()
	if err == nil {
		sqlDB.Close() //nolint:errcheck,gosec // closing on shutdown
	}
}
