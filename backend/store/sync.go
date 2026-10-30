package store

import (
	"context"
	"time"

	"fast_chat/model"
)

// DefaultSyncPageLimit bounds one sync-delta page per list. The client and
// the federation catch-up loop on NextSince until no list is full, so a
// large offline backlog streams in bounded pages instead of one unbounded
// response. Every delta application is idempotent (upsert by id), so the
// intentional page overlap at the cursor is harmless.
const DefaultSyncPageLimit = 500

// DeltaPage is one bounded page of a sync delta list with its keyset
// continuation cursor. Empty NextSince (via HasMore=false) ends paging.
type DeltaPage[T any] struct {
	Rows      []T
	NextSince time.Time
	NextID    string
	HasMore   bool
}

// messagesChangedSince is the shared core of the chat and thread deltas.
// threadFilter selects the container (threadIDIsEmpty vs threadIDIsNotEmpty);
// the name is only used for the failure log.
//
// Rows are ordered by the cursor (updated_at, id) so LIMIT cuts at a
// resumable boundary: the caller resumes strictly past (nextSince,
// nextSinceID) and never sees a row twice nor skips one, even when many
// rows share a timestamp. hasMore reports a full page. Failures are
// returned: an empty page is indistinguishable from "end of history" to
// the caller, which could then wrongly discard its cache.
func (s *Store) messagesChangedSince(
	ctx context.Context,
	threadFilter string,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.Message], error) {

	if len(chatIDs) == 0 {
		return DeltaPage[model.Message]{}, nil
	}

	if limit <= 0 {
		limit = DefaultSyncPageLimit
	}

	// Stored timestamps are UTC text; a cursor carrying a non-zero offset
	// would be compared lexicographically by wall-clock digits. Normalize
	// to UTC so the comparison is over the instant.
	since = since.UTC()

	var msgs []model.Message
	query := "chat_id IN ? AND " + threadFilter + " AND (updated_at > ? OR (updated_at = ? AND id > ?))"
	if err := s.db.WithContext(ctx).Where(query, chatIDs, since, since, sinceID).
		Order("updated_at ASC, id ASC").
		Limit(limit).
		Find(&msgs).Error; err != nil {
		return DeltaPage[model.Message]{}, err
	}

	if len(msgs) == 0 {
		return DeltaPage[model.Message]{}, nil
	}

	ids := make([]string, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}

	// GetMessageFilesBatch fans out in bounded chunks. A failure fails the
	// page: delivering messages without their files would advance the
	// cursor past them and hide the attachments until the next edit.
	filesByMsg, err := s.GetMessageFilesBatch(ctx, ids)
	if err != nil {
		return DeltaPage[model.Message]{}, err
	}

	for i := range msgs {
		msgs[i].Files = filesByMsg[msgs[i].ID]
	}

	last := msgs[len(msgs)-1]
	return DeltaPage[model.Message]{
		Rows:      msgs,
		NextSince: last.UpdatedAt,
		NextID:    last.ID,
		HasMore:   len(msgs) == limit,
	}, nil
}

// MessagesChangedSince returns a page of top-level messages in the given
// chats whose `updated_at` is >= `since`, plus their attached files. This
// includes newly created messages and edits.
//
// Thread messages are deliberately excluded: the client stores them in a
// separate IDB object, and the delta applier writes everything it receives
// into the chat message store, so including them would duplicate a thread
// into the chat feed. They are delivered by ThreadMessagesChangedSince, which
// the client routes into the thread store.
func (s *Store) MessagesChangedSince(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.Message], error) {

	return s.messagesChangedSince(ctx, threadIDIsEmpty, chatIDs, since, sinceID, limit)
}

// ThreadMessagesChangedSince returns a page of the messages of the threads
// of the given chats whose `updated_at` is >= `since`.
//
// The thread messages are delivered separately from the chat messages: the
// client keeps them in their own store, and a single list would put every
// thread message back into the chat feed.
func (s *Store) ThreadMessagesChangedSince(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.Message], error) {

	return s.messagesChangedSince(ctx, threadIDIsNotEmpty, chatIDs, since, sinceID, limit)
}

// DeletedMessagesSince returns a page of tombstones for messages removed
// after `since` in the given chats. The keyset cursor is
// (deleted_at, message_id).
func (s *Store) DeletedMessagesSince(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.DeletedMessage], error) {

	if len(chatIDs) == 0 {
		return DeltaPage[model.DeletedMessage]{}, nil
	}

	if limit <= 0 {
		limit = DefaultSyncPageLimit
	}

	since = since.UTC()

	var tombs []model.DeletedMessage
	if err := s.db.WithContext(ctx).Where("chat_id IN ? AND (deleted_at > ? OR (deleted_at = ? AND message_id > ?))", chatIDs, since, since, sinceID).
		Order("deleted_at ASC, message_id ASC").
		Limit(limit).
		Find(&tombs).Error; err != nil {
		return DeltaPage[model.DeletedMessage]{}, err
	}

	if len(tombs) == 0 {
		return DeltaPage[model.DeletedMessage]{}, nil
	}

	last := tombs[len(tombs)-1]
	return DeltaPage[model.DeletedMessage]{
		Rows:      tombs,
		NextSince: last.DeletedAt,
		NextID:    last.MessageID,
		HasMore:   len(tombs) == limit,
	}, nil
}

// DeletedChatsSince returns a page of tombstones for chats (visible to a
// given user) that were deleted after `since`. Used to tell an offline user
// that a group chat they were in was removed. The keyset cursor is
// (deleted_at, chat_id).
func (s *Store) DeletedChatsSince(
	ctx context.Context,
	userID string,
	since time.Time,
	sinceID string,
	limit int,
) (DeltaPage[model.DeletedChat], error) {

	if limit <= 0 {
		limit = DefaultSyncPageLimit
	}

	since = since.UTC()

	var tombs []model.DeletedChat
	if err := s.db.WithContext(ctx).Where("user_id = ? AND (deleted_at > ? OR (deleted_at = ? AND chat_id > ?))", userID, since, since, sinceID).
		Order("deleted_at ASC, chat_id ASC").
		Limit(limit).
		Find(&tombs).Error; err != nil {
		return DeltaPage[model.DeletedChat]{}, err
	}

	if len(tombs) == 0 {
		return DeltaPage[model.DeletedChat]{}, nil
	}

	last := tombs[len(tombs)-1]
	return DeltaPage[model.DeletedChat]{
		Rows:      tombs,
		NextSince: last.DeletedAt,
		NextID:    last.ChatID,
		HasMore:   len(tombs) == limit,
	}, nil
}
