package store

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

const (
	chatTypePrivate = "private"
	chatTypeGroup   = "group"
)

var (
	ErrChatNotFound = errors.New("chat not found")
)

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
		now := time.Now()

		if err := writeChatDeleteTombs(tx, chatID, chat.Members, now); err != nil {
			return err
		}

		if err := writeMessageDeleteTombs(tx, chatID, now); err != nil {
			return err
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

func writeChatDeleteTombs(tx *gorm.DB, chatID string, members []string, at time.Time) error {
	if len(members) == 0 {
		return nil
	}

	tombs := make([]model.DeletedChat, 0, len(members))
	for _, memberID := range members {
		tombs = append(tombs, model.DeletedChat{
			ChatID:    chatID,
			UserID:    memberID,
			DeletedAt: at,
		})
	}

	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&tombs).Error
}

func writeMessageDeleteTombs(tx *gorm.DB, chatID string, at time.Time) error {
	var msgIDs []string
	if err := tx.Model(&model.Message{}).Where("chat_id = ?", chatID).Pluck("id", &msgIDs).Error; err != nil {
		return err
	}

	if len(msgIDs) == 0 {
		return nil
	}

	tombs := make([]model.DeletedMessage, 0, len(msgIDs))
	for _, mid := range msgIDs {
		tombs = append(tombs, model.DeletedMessage{
			ChatID:    chatID,
			MessageID: mid,
			DeletedAt: at,
		})
	}

	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&tombs).Error; err != nil {
		return err
	}

	if err := tx.Where("message_id IN ?", msgIDs).Delete(&model.MessageFile{}).Error; err != nil {
		return err
	}

	return tx.Where("chat_id = ?", chatID).Delete(&model.Message{}).Error
}

func (s *Store) GetUserChats(userID string) []*model.Chat {
	var chatIDs []string

	s.db.Model(&ChatMember{}).Where("user_id = ?", userID).Pluck("chat_id", &chatIDs)

	if len(chatIDs) == 0 {
		return nil
	}

	var chats []*model.Chat

	s.db.Where("id IN ?", chatIDs).Order("created_at DESC").Find(&chats)

	// One query for all memberships across all of the user's chats,
	// instead of one query per chat. The lookup table is small enough
	// to keep in memory.
	type memberRow struct {
		ChatID string
		UserID string
	}

	var rows []memberRow
	s.db.Model(&ChatMember{}).
		Where("chat_id IN ?", chatIDs).
		Select("chat_id, user_id").
		Scan(&rows)

	membersByChat := make(map[string][]string, len(chats))
	for _, r := range rows {
		membersByChat[r.ChatID] = append(membersByChat[r.ChatID], r.UserID)
	}

	for _, c := range chats {
		c.Members = membersByChat[c.ID]
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
