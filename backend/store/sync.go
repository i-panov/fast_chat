package store

import (
	"time"

	"fast_chat/model"
)

// ChatChangedSince returns group chats the user belongs to that were
// created on or after `since`. Private chats have stable IDs and rarely
// disappear from a user's perspective, so this list is a best-effort
// hint; the authoritative list of "current chats" is GetUserChats.
func (s *Store) ChatChangedSince(userID string, since time.Time) []*model.Chat {
	var chatIDs []string

	s.db.Model(&ChatMember{}).Where("user_id = ?", userID).Pluck("chat_id", &chatIDs)

	if len(chatIDs) == 0 {
		return nil
	}

	var chats []*model.Chat
	s.db.Where("id IN ? AND created_at >= ?", chatIDs, since).
		Order("created_at ASC").
		Find(&chats)

	if len(chats) == 0 {
		return nil
	}

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

// MessagesChangedSince returns all messages in the given chats whose
// `updated_at` is >= `since`, plus their attached files. This includes
// newly created messages and edits.
func (s *Store) MessagesChangedSince(chatIDs []string, since time.Time) []model.Message {
	if len(chatIDs) == 0 {
		return nil
	}

	var msgs []model.Message
	s.db.Where("chat_id IN ? AND updated_at >= ?", chatIDs, since).
		Order("created_at ASC, id ASC").
		Find(&msgs)

	if len(msgs) == 0 {
		return nil
	}

	ids := make([]string, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}

	filesByMsg, err := s.GetMessageFilesBatch(ids)
	if err != nil {
		return msgs
	}

	for i := range msgs {
		msgs[i].Files = filesByMsg[msgs[i].ID]
	}

	return msgs
}

// DeletedMessagesSince returns tombstones for messages removed after
// `since` in the given chats.
func (s *Store) DeletedMessagesSince(chatIDs []string, since time.Time) []model.DeletedMessage {
	if len(chatIDs) == 0 {
		return nil
	}

	var tombs []model.DeletedMessage
	s.db.Where("chat_id IN ? AND deleted_at >= ?", chatIDs, since).
		Order("deleted_at ASC").
		Find(&tombs)

	return tombs
}

// DeletedChatsSince returns tombstones for chats (visible to a given
// user) that were deleted after `since`. Used to tell an offline user
// that a group chat they were in was removed.
func (s *Store) DeletedChatsSince(userID string, since time.Time) []model.DeletedChat {
	var tombs []model.DeletedChat
	s.db.Where("user_id = ? AND deleted_at >= ?", userID, since).
		Order("deleted_at ASC").
		Find(&tombs)

	return tombs
}
