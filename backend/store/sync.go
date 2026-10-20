package store

import (
	"context"
	"time"

	"fast_chat/model"
)

// MessagesChangedSince returns all top-level messages in the given chats
// whose `updated_at` is >= `since`, plus their attached files. This includes
// newly created messages and edits.
//
// Thread messages are deliberately excluded: the client stores them in a
// separate IDB object, and the delta applier writes everything it receives
// into the chat message store, so including them would duplicate a thread
// into the chat feed. They are delivered by ThreadMessagesChangedSince, which
// the client routes into the thread store.
func (s *Store) MessagesChangedSince(ctx context.Context, chatIDs []string, since time.Time) []model.Message {
	if len(chatIDs) == 0 {
		return nil
	}

	var msgs []model.Message
	s.db.WithContext(ctx).Where("chat_id IN ? AND "+threadIDIsEmpty+" AND updated_at >= ?", chatIDs, since).
		Order("created_at ASC, id ASC").
		Find(&msgs)

	if len(msgs) == 0 {
		return nil
	}

	ids := make([]string, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}

	filesByMsg, err := s.GetMessageFilesBatch(ctx, ids)
	if err != nil {
		return msgs
	}

	for i := range msgs {
		msgs[i].Files = filesByMsg[msgs[i].ID]
	}

	return msgs
}

// ThreadMessagesChangedSince returns the messages of the threads of the given
// chats whose `updated_at` is >= `since`.
//
// The thread messages are delivered separately from the chat messages: the
// client keeps them in their own store, and a single list would put every
// thread message back into the chat feed.
func (s *Store) ThreadMessagesChangedSince(ctx context.Context, chatIDs []string, since time.Time) []model.Message {
	if len(chatIDs) == 0 {
		return nil
	}

	var msgs []model.Message

	s.db.WithContext(ctx).Where("chat_id IN ? AND "+threadIDIsNotEmpty+" AND updated_at >= ?", chatIDs, since).
		Order("created_at ASC, id ASC").
		Find(&msgs)

	if len(msgs) == 0 {
		return nil
	}

	ids := make([]string, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}

	filesByMsg, err := s.GetMessageFilesBatch(ctx, ids)
	if err == nil {
		for i := range msgs {
			msgs[i].Files = filesByMsg[msgs[i].ID]
		}
	}

	return msgs
}

// DeletedMessagesSince returns tombstones for messages removed after
// `since` in the given chats.
func (s *Store) DeletedMessagesSince(ctx context.Context, chatIDs []string, since time.Time) []model.DeletedMessage {
	if len(chatIDs) == 0 {
		return nil
	}

	var tombs []model.DeletedMessage
	s.db.WithContext(ctx).Where("chat_id IN ? AND deleted_at >= ?", chatIDs, since).
		Order("deleted_at ASC").
		Find(&tombs)

	return tombs
}

// DeletedChatsSince returns tombstones for chats (visible to a given
// user) that were deleted after `since`. Used to tell an offline user
// that a group chat they were in was removed.
func (s *Store) DeletedChatsSince(ctx context.Context, userID string, since time.Time) []model.DeletedChat {
	var tombs []model.DeletedChat
	s.db.WithContext(ctx).Where("user_id = ? AND deleted_at >= ?", userID, since).
		Order("deleted_at ASC").
		Find(&tombs)

	return tombs
}
