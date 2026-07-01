package store

import (
	"context"
	"errors"
	"fmt"
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

func (s *Store) CreateChat(ctx context.Context, member1, member2, remoteServer string) (*model.Chat, error) {
	var chatIDs []string

	s.db.WithContext(ctx).Model(&ChatMember{}).
		Select("chat_id").
		Where("user_id IN ?", []string{member1, member2}).
		Group("chat_id").
		Having("COUNT(DISTINCT user_id) = 2").
		Pluck("chat_id", &chatIDs)

	if len(chatIDs) > 0 { //nolint:nestif
		var chat model.Chat

		chatIDQuery := s.db.WithContext(ctx).Model(&model.Chat{}).
			Select("id").
			Where("id IN ? AND type = ?", chatIDs, chatTypePrivate)

		var foundID string
		if err := chatIDQuery.Limit(1).Row().Scan(&foundID); err == nil {
			if err := s.db.WithContext(ctx).First(&chat, "id = ?", foundID).Error; err == nil {
				chat.Members = []string{member1, member2}

				if remoteServer != "" && chat.RemoteServer == "" {
					s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chat.ID).Update("remote_server", remoteServer)
					chat.RemoteServer = remoteServer
				}

				return &chat, nil
			}
		}
	}

	id := GenerateID()
	chat := &model.Chat{
		ID:           id,
		Type:         chatTypePrivate,
		RemoteServer: remoteServer,
		CreatedAt:    time.Now(),
	}

	if err := s.db.WithContext(ctx).Create(chat).Error; err != nil {
		return nil, err
	}

	members := []ChatMember{
		{ChatID: id, UserID: member1},
		{ChatID: id, UserID: member2},
	}

	if err := s.db.WithContext(ctx).Create(&members).Error; err != nil {
		return nil, err
	}

	chat.Members = []string{member1, member2}

	return chat, nil
}

func (s *Store) CreateGroupChat(ctx context.Context, name, ownerID string, memberIDs []string, remoteServer string) (*model.Chat, error) {
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

	id := GenerateID()
	chat := &model.Chat{
		ID:           id,
		Type:         chatTypeGroup,
		Name:         name,
		OwnerID:      ownerID,
		RemoteServer: remoteServer,
		CreatedAt:    time.Now(),
	}

	if err := s.db.WithContext(ctx).Create(chat).Error; err != nil {
		return nil, err
	}

	members := make([]ChatMember, 0, len(dedup))
	for _, m := range dedup {
		members = append(members, ChatMember{ChatID: id, UserID: m})
	}

	if err := s.db.WithContext(ctx).Create(&members).Error; err != nil {
		return nil, err
	}

	chat.Members = dedup

	return chat, nil
}

func (s *Store) AddChatMember(ctx context.Context, chatID, userID string) error {
	chat, ok := s.GetChat(ctx, chatID)
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

	return s.db.WithContext(ctx).Create(&ChatMember{ChatID: chatID, UserID: userID}).Error
}

func (s *Store) RemoveChatMember(ctx context.Context, chatID, userID string) error {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return errors.New("cannot remove members from non-group chat")
	}

	if len(chat.Members) <= 1 {
		return errors.New("cannot remove the last member")
	}

	return s.db.WithContext(ctx).Where("chat_id = ? AND user_id = ?", chatID, userID).Delete(&ChatMember{}).Error
}

func (s *Store) findGroupChat(ctx context.Context, chatID string) (*model.Chat, error) {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return nil, ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return nil, errors.New("not a group chat")
	}

	return chat, nil
}

func (s *Store) UpdateChatName(ctx context.Context, chatID, name string) (*model.Chat, error) {
	chat, err := s.findGroupChat(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("cannot rename: %w", err)
	}

	if err := s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chatID).Update("name", name).Error; err != nil {
		return nil, err
	}

	chat.Name = name

	return chat, nil
}

func (s *Store) UpdateChatAvatar(ctx context.Context, chatID, fileID string) (*model.Chat, error) {
	chat, err := s.findGroupChat(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("cannot set avatar: %w", err)
	}

	if err := s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chatID).Update("avatar_file_id", fileID).Error; err != nil {
		return nil, err
	}

	chat.AvatarFileID = fileID

	return chat, nil
}

func (s *Store) GetChatsByAvatarFileID(ctx context.Context, fileID string) ([]string, error) {
	var chatIDs []string

	err := s.db.WithContext(ctx).Model(&model.Chat{}).
		Where("avatar_file_id = ?", fileID).
		Pluck("id", &chatIDs).
		Error

	if chatIDs == nil {
		return []string{}, nil
	}

	return chatIDs, err
}

func (s *Store) DeleteChat(ctx context.Context, chatID string) error {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return errors.New("cannot delete non-group chat")
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
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

func (s *Store) GetUserChats(ctx context.Context, userID string) []*model.Chat {
	var chatIDs []string

	s.db.WithContext(ctx).Model(&ChatMember{}).Where("user_id = ?", userID).Pluck("chat_id", &chatIDs)

	if len(chatIDs) == 0 {
		return nil
	}

	var chats []*model.Chat

	s.db.WithContext(ctx).Where("id IN ?", chatIDs).Order("created_at DESC").Find(&chats)

	// One query for all memberships across all of the user's chats,
	// instead of one query per chat. The lookup table is small enough
	// to keep in memory.
	type memberRow struct {
		ChatID string
		UserID string
	}

	var rows []memberRow
	s.db.WithContext(ctx).Model(&ChatMember{}).
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

func (s *Store) GetChat(ctx context.Context, chatID string) (*model.Chat, bool) {
	var chat model.Chat

	if err := s.db.WithContext(ctx).First(&chat, "id = ?", chatID).Error; err != nil {
		return nil, false
	}

	var members []string

	s.db.WithContext(ctx).Model(&ChatMember{}).Where("chat_id = ?", chatID).Pluck("user_id", &members)
	chat.Members = members

	return &chat, true
}

func (s *Store) GetFederatedChatIDs(ctx context.Context, remoteServer string) []string {
	var chatIDs []string
	s.db.WithContext(ctx).Model(&model.Chat{}).Where("remote_server = ?", remoteServer).Pluck("id", &chatIDs)

	if len(chatIDs) == 0 {
		return []string{}
	}

	return chatIDs
}

func (s *Store) CreateRemoteChat(ctx context.Context, chat *model.Chat) error {
	var count int64
	s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chat.ID).Count(&count)

	if count > 0 {
		return nil
	}

	if chat.Type == "" {
		chat.Type = chatTypePrivate
	}

	if err := s.db.WithContext(ctx).Create(chat).Error; err != nil {
		return err
	}

	members := make([]ChatMember, len(chat.Members))

	for i, m := range chat.Members {
		members[i] = ChatMember{ChatID: chat.ID, UserID: m}
	}

	return s.db.WithContext(ctx).Create(&members).Error
}
