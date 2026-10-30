package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

const (
	chatTypePrivate = "private"
	chatTypeGroup   = "group"
	chatTypeSelf    = "self"
)

var (
	ErrChatNotFound       = errors.New("chat not found")
	ErrGroupChatNoMembers = errors.New("group chat must have at least one member (the owner)")
	ErrAddMemberToPrivate = errors.New("cannot add members to non-group chat")
	ErrTooManyMembers     = errors.New("too many members")
	ErrRemoveFromPrivate  = errors.New("cannot remove members from non-group chat")
	ErrRemoveLastMember   = errors.New("cannot remove the last member")
	ErrNotGroupChat       = errors.New("not a group chat")
	ErrDeleteNonGroup     = errors.New("cannot delete non-group chat")
	ErrSelfPrivateChat    = errors.New("private chat with self must use EnsureSelfChat")
)

func (s *Store) CreateChat(ctx context.Context, member1, member2, remoteServer string) (*model.Chat, error) {
	// A self-pair would never match findPrivateChat (COUNT DISTINCT = 2 is
	// unreachable) and mint a duplicate private chat per call. Self chats
	// live under EnsureSelfChat with a deterministic id and "self" type.
	if member1 == member2 {
		return nil, ErrSelfPrivateChat
	}

	chat, ok, err := s.findPrivateChat(ctx, member1, member2, remoteServer)
	if err != nil {
		return nil, err
	}

	if ok {
		return chat, nil
	}

	id := GenerateID()
	chat = &model.Chat{
		ID:           id,
		Type:         chatTypePrivate,
		RemoteServer: remoteServer,
		CreatedAt:    time.Now().UTC(),
	}

	// A self-pair carries one membership row: two identical rows would hit
	// the (chat_id, user_id) primary key.
	memberIDs := []string{member1}
	if member2 != "" && member2 != member1 {
		memberIDs = append(memberIDs, member2)
	}

	members := make([]ChatMember, 0, len(memberIDs))
	for _, memberID := range memberIDs {
		members = append(members, ChatMember{ChatID: id, UserID: memberID})
	}

	// Chat and members go out in one transaction so a crash between them
	// cannot leave a member-less orphan visible in lists.
	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(chat).Error; err != nil {
			return err
		}

		return tx.Create(&members).Error
	}); err != nil {
		return nil, err
	}

	chat.Members = memberIDs

	return chat, nil
}

// findPrivateChat returns the existing private chat of the two members.
// ok=false means no such chat (or a lookup miss); err reports a database
// failure, which the caller must not mistake for "no chat".
func (s *Store) findPrivateChat(ctx context.Context, member1, member2, remoteServer string) (*model.Chat, bool, error) {
	var chatIDs []string

	if err := s.db.WithContext(ctx).Model(&ChatMember{}).
		Select("chat_id").
		Where("user_id IN ?", []string{member1, member2}).
		Group("chat_id").
		Having("COUNT(DISTINCT user_id) = 2").
		Pluck("chat_id", &chatIDs).Error; err != nil {
		return nil, false, err
	}

	if len(chatIDs) == 0 {
		return nil, false, nil
	}

	var foundID string
	chatIDQuery := s.db.WithContext(ctx).Model(&model.Chat{}).
		Select("id").
		Where("id IN ? AND type = ?", chatIDs, chatTypePrivate)

	if scanErr := chatIDQuery.Limit(1).Row().Scan(&foundID); scanErr != nil {
		// Only a miss means "no private chat": a transient failure must
		// surface, or the caller mints a duplicate chat on top of it.
		if errors.Is(scanErr, sql.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, scanErr
	}

	var chat model.Chat
	if firstErr := s.db.WithContext(ctx).First(&chat, "id = ?", foundID).Error; firstErr != nil {
		if errors.Is(firstErr, gorm.ErrRecordNotFound) {
			return nil, false, nil
		}
		return nil, false, firstErr
	}

	chat.Members = []string{member1, member2}

	if remoteServer != "" && chat.RemoteServer == "" {
		if err := s.db.WithContext(ctx).Model(&model.Chat{}).Where("id = ?", chat.ID).Update("remote_server", remoteServer).Error; err != nil {
			return nil, false, err
		}

		chat.RemoteServer = remoteServer
	}

	return &chat, true, nil
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
		return nil, ErrGroupChatNoMembers
	}

	id := GenerateID()
	chat := &model.Chat{
		ID:           id,
		Type:         chatTypeGroup,
		Name:         name,
		OwnerID:      ownerID,
		RemoteServer: remoteServer,
		CreatedAt:    time.Now().UTC(),
	}

	members := make([]ChatMember, 0, len(dedup))
	for _, m := range dedup {
		members = append(members, ChatMember{ChatID: id, UserID: m})
	}

	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(chat).Error; err != nil {
			return err
		}

		return tx.Create(&members).Error
	}); err != nil {
		return nil, err
	}

	chat.Members = dedup

	return chat, nil
}

func selfChatID(userID string) string {
	h := sha256.Sum256([]byte("self-chat:" + userID))
	return hex.EncodeToString(h[:16])
}

func (s *Store) EnsureSelfChat(ctx context.Context, userID string) (*model.Chat, error) {
	chatID := selfChatID(userID)

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&model.Chat{ID: chatID, Type: chatTypeSelf, CreatedAt: time.Now().UTC()}).Error; err != nil {
			return err
		}

		return tx.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&ChatMember{ChatID: chatID, UserID: userID}).Error
	})

	if err != nil {
		return nil, err
	}

	var chat model.Chat
	if err := s.db.WithContext(ctx).First(&chat, "id = ?", chatID).Error; err != nil {
		return nil, err
	}

	var members []string
	if err := s.db.WithContext(ctx).Model(&ChatMember{}).Where("chat_id = ?", chatID).Pluck("user_id", &members).Error; err != nil {
		return nil, err
	}
	chat.Members = members

	return &chat, nil
}

func (s *Store) AddChatMember(ctx context.Context, chatID, userID string, maxMembers int) error {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return ErrAddMemberToPrivate
	}

	if slices.Contains(chat.Members, userID) {
		return nil
	}

	// The count check and insert run in a single write transaction so
	// concurrent AddChatMember calls cannot exceed maxMembers. SQLite
	// serializes write transactions, making this atomic. The insert is an
	// upsert so two concurrent adds of the same user do not race into a
	// UNIQUE failure after both passing the fast-path Contains above.
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&ChatMember{}).Where("chat_id = ?", chatID).Count(&count).Error; err != nil {
			return err
		}

		if count >= int64(maxMembers) {
			return ErrTooManyMembers
		}

		return tx.Clauses(clause.OnConflict{DoNothing: true}).
			Create(&ChatMember{ChatID: chatID, UserID: userID}).Error
	})
}

// RemoveChatMember drops the membership and leaves a tombstone for the
// removed user.
//
// The tombstone is what tells a client that was offline during the removal
// that the chat is gone: without it the chat would stay in the local list
// forever, because the sync delta only carries the chats a user belongs to.
func (s *Store) RemoveChatMember(ctx context.Context, chatID, userID string) error {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return ErrRemoveFromPrivate
	}

	// The last-member guard lives inside the write transaction: checking the
	// snapshot above lets two concurrent removes from a two-member group
	// both see len==2 and empty the chat.
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&ChatMember{}).Where("chat_id = ?", chatID).Count(&count).Error; err != nil {
			return err
		}

		if count == 0 {
			return ErrChatNotFound
		}

		if count <= 1 {
			return ErrRemoveLastMember
		}

		result := tx.Where("chat_id = ? AND user_id = ?", chatID, userID).Delete(&ChatMember{})
		if result.Error != nil {
			return result.Error
		}

		if result.RowsAffected == 0 {
			return nil
		}

		return writeChatDeleteTombs(tx, chatID, []string{userID}, time.Now().UTC())
	})
}

// ReplaceChatMembers sets the membership of a chat to exactly the given
// list. It is used by the federation catch-up, where the peer is
// authoritative for the chat: a member that joined or left has to be applied
// even when the change happened while this server was offline.
//
// Every member that is dropped leaves a tombstone, the same way a local
// removal does: without it the chat of a removed member would stay in the
// local list forever, because the sync delta only carries the chats a user
// belongs to.
func (s *Store) ReplaceChatMembers(ctx context.Context, chatID string, members []string) error {
	wanted := make(map[string]struct{}, len(members))
	for _, memberID := range members {
		if memberID == "" {
			continue
		}

		wanted[memberID] = struct{}{}
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var chat model.Chat
		if err := tx.First(&chat, "id = ?", chatID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrChatNotFound
			}

			return err
		}

		var current []ChatMember
		if err := tx.Where("chat_id = ?", chatID).Find(&current).Error; err != nil {
			return err
		}

		removed := make([]string, 0, len(current))

		for _, member := range current {
			if _, ok := wanted[member.UserID]; ok {
				delete(wanted, member.UserID)
				continue
			}

			if err := tx.Where("chat_id = ? AND user_id = ?", chatID, member.UserID).
				Delete(&ChatMember{}).Error; err != nil {
				return err
			}

			removed = append(removed, member.UserID)
		}

		if len(wanted) > 0 {
			rows := make([]ChatMember, 0, len(wanted))
			for memberID := range wanted {
				rows = append(rows, ChatMember{ChatID: chatID, UserID: memberID})
			}

			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error; err != nil {
				return err
			}
		}

		return writeChatDeleteTombs(tx, chatID, removed, time.Now().UTC())
	})
}

func (s *Store) findGroupChat(ctx context.Context, chatID string) (*model.Chat, error) {
	chat, ok := s.GetChat(ctx, chatID)
	if !ok {
		return nil, ErrChatNotFound
	}

	if chat.Type != chatTypeGroup {
		return nil, ErrNotGroupChat
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

func (s *Store) GetChatsByIDs(ctx context.Context, ids []string) ([]model.Chat, error) {
	var chats []model.Chat
	if err := s.db.WithContext(ctx).Where("id IN ?", ids).Find(&chats).Error; err != nil {
		return nil, err
	}

	var members []ChatMember
	if err := s.db.WithContext(ctx).Where("chat_id IN ?", ids).Find(&members).Error; err != nil {
		return nil, err
	}

	memberMap := make(map[string][]string, len(chats))
	for _, m := range members {
		memberMap[m.ChatID] = append(memberMap[m.ChatID], m.UserID)
	}

	for i := range chats {
		chats[i].Members = memberMap[chats[i].ID]
	}

	return chats, nil
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
		return ErrDeleteNonGroup
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()

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

// writeChatDeleteTombs records that the given members no longer have the
// chat. A member can leave and come back, so an existing tombstone is
// refreshed instead of being kept: the timestamp has to describe the latest
// removal, otherwise a client whose cursor is past the first removal would
// never learn about the second one.
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

	return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&tombs).Error
}

// The driver rejects a statement binding more than sqliteMaxVariables
// parameters. A tombstone binds three columns and an IN list binds one per id,
// so a chat with more than about 10900 messages could not be deleted at all: the
// error came from inside the transaction, which rolled back everything and
// returned the same error on every retry.
//
// Measured on this driver: a 3-column bulk insert fails at 33000 parameters and
// an IN list at 33000 ids.
const sqliteMaxVariables = 32766

const (
	// deleteBatchRows bounds a batched tombstone insert. A tombstone binds three
	// columns, so the divisor leaves roughly 6000 parameters against a ceiling
	// of 32766, and deriving it keeps the two from drifting apart.
	deleteBatchRows = sqliteMaxVariables / 16

	// deleteBatchIDs bounds a batched IN list, which binds one parameter per id.
	deleteBatchIDs = sqliteMaxVariables / 16
)

func writeMessageDeleteTombs(tx *gorm.DB, chatID string, at time.Time) error {
	var msgIDs []string
	if err := tx.Model(&model.Message{}).Where("chat_id = ?", chatID).Pluck("id", &msgIDs).Error; err != nil {
		return err
	}

	if len(msgIDs) == 0 {
		return nil
	}

	for start := 0; start < len(msgIDs); start += deleteBatchRows {
		end := min(start+deleteBatchRows, len(msgIDs))

		tombs := make([]model.DeletedMessage, 0, end-start)
		for _, mid := range msgIDs[start:end] {
			tombs = append(tombs, model.DeletedMessage{
				ChatID:    chatID,
				MessageID: mid,
				DeletedAt: at,
			})
		}

		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&tombs).Error; err != nil {
			return err
		}
	}

	for start := 0; start < len(msgIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(msgIDs))

		if err := tx.Where("message_id IN ?", msgIDs[start:end]).Delete(&model.MessageFile{}).Error; err != nil {
			return err
		}

		// Read receipts of deleted messages must go with them: otherwise
		// they linger forever and are still served for removed messages.
		// The table may not exist in older test schemas, so probe first.
		if tx.Migrator().HasTable(&model.MessageReadStatus{}) {
			if err := tx.Where("message_id IN ?", msgIDs[start:end]).Delete(&model.MessageReadStatus{}).Error; err != nil {
				return err
			}
		}
	}

	return tx.Where("chat_id = ?", chatID).Delete(&model.Message{}).Error
}

func (s *Store) GetUserChats(ctx context.Context, userID string) []*model.Chat {
	var chatIDs []string

	if err := s.db.WithContext(ctx).Model(&ChatMember{}).Where("user_id = ?", userID).Pluck("chat_id", &chatIDs).Error; err != nil {
		slog.Warn("GetUserChats: failed to list chat ids", "userID", userID, "err", err)
		return nil
	}

	if len(chatIDs) == 0 {
		return nil
	}

	var chats []*model.Chat

	chatsQuery := s.db.WithContext(ctx).Where("id IN ?", chatIDs).
		Order("CASE WHEN type = 'self' THEN 0 ELSE 1 END, created_at DESC")
	if err := chatsQuery.Find(&chats).Error; err != nil {
		slog.Warn("GetUserChats: failed to load chats", "userID", userID, "err", err)
		return nil
	}

	// One query for all memberships across all of the user's chats,
	// instead of one query per chat. The lookup table is small enough
	// to keep in memory.
	type memberRow struct {
		ChatID string
		UserID string
	}

	var rows []memberRow
	if err := s.db.WithContext(ctx).Model(&ChatMember{}).
		Where("chat_id IN ?", chatIDs).
		Select("chat_id, user_id").
		Scan(&rows).Error; err != nil {
		slog.Warn("GetUserChats: failed to load members", "userID", userID, "err", err)
		return nil
	}

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

	if err := s.db.WithContext(ctx).Model(&ChatMember{}).Where("chat_id = ?", chatID).Pluck("user_id", &members).Error; err != nil {
		slog.Warn("GetChat: failed to load members", "chatID", chatID, "err", err)
		return nil, false
	}
	chat.Members = members

	return &chat, true
}

func (s *Store) GetFederatedChatIDs(ctx context.Context, remoteServer string) []string {
	var chatIDs []string
	if err := s.db.WithContext(ctx).Model(&model.Chat{}).Where("remote_server = ?", remoteServer).Pluck("id", &chatIDs).Error; err != nil {
		slog.Warn("GetFederatedChatIDs failed", "err", err)
		return []string{}
	}

	if len(chatIDs) == 0 {
		return []string{}
	}

	return chatIDs
}

func (s *Store) CreateRemoteChat(ctx context.Context, chat *model.Chat) error {
	if chat.Type == "" {
		chat.Type = chatTypePrivate
	}

	if chat.CreatedAt.IsZero() {
		chat.CreatedAt = time.Now().UTC()
	} else {
		chat.CreatedAt = chat.CreatedAt.UTC()
	}

	seen := make(map[string]struct{}, len(chat.Members))
	dedup := make([]ChatMember, 0, len(chat.Members))
	for _, memberID := range chat.Members {
		if memberID == "" {
			continue
		}
		if _, ok := seen[memberID]; ok {
			continue
		}
		seen[memberID] = struct{}{}
		dedup = append(dedup, ChatMember{ChatID: chat.ID, UserID: memberID})
	}

	// Idempotent: a concurrent federated receive of the same chat hits the
	// primary key and becomes a no-op instead of a conflict.
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(chat).Error; err != nil {
			return err
		}

		if len(dedup) == 0 {
			return nil
		}

		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&dedup).Error
	})
}
