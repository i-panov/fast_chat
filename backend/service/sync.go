package service

import (
	"context"
	"time"

	"fast_chat/model"
	"fast_chat/store"
)

const syncDefaultSince = "1970-01-01T00:00:00Z"

// SyncChatDTO describes a changed chat in the sync response.
type SyncChatDTO struct {
	ID        string       `json:"id"`
	Type      string       `json:"type"`
	Name      string       `json:"name"`
	OwnerID   string       `json:"ownerId"`
	AvatarURL string       `json:"avatarUrl,omitempty"`
	Members   []MemberView `json:"members"`
	CreatedAt time.Time    `json:"createdAt"`
}

// SyncDeletedMessageDTO is a tombstone for a deleted message.
type SyncDeletedMessageDTO struct {
	ChatID    string    `json:"chatId"`
	MessageID string    `json:"messageId"`
	DeletedAt time.Time `json:"deletedAt"`
}

// SyncDeletedChatDTO is a tombstone for a deleted chat.
type SyncDeletedChatDTO struct {
	ChatID    string    `json:"chatId"`
	DeletedAt time.Time `json:"deletedAt"`
}

// SyncResponse is the state of the account as the server sees it.
//
// The chat list is complete, not a delta: a chat the user joined, a renamed
// group or a changed membership does not change the creation date of the
// chat, so a "changed since" query would lose exactly the changes that
// matter while the client was offline. The messages and the tombstones are
// deltas since the cursor of the client.
//
// The messages of the threads travel in their own list: the client keeps them
// in a separate store, and a single list would put every thread message back
// into the chat feed.
type SyncResponse struct {
	ServerNow       time.Time               `json:"serverNow"`
	Chats           []SyncChatDTO           `json:"chats"`
	DeletedChats    []SyncDeletedChatDTO    `json:"deletedChats"`
	Messages        []model.Message         `json:"messages"`
	ThreadMessages  []model.Message         `json:"threadMessages"`
	DeletedMessages []SyncDeletedMessageDTO `json:"deletedMessages"`
	OnlineStatus    map[string]bool         `json:"onlineStatus,omitempty"`
	// NextSince continues the delta when a list hit the page limit
	// (RFC3339, empty when the delta is complete); NextSinceID is its id
	// tiebreaker. The client loops on them; the (time, id) keyset never
	// loses or duplicates rows.
	NextSince   string `json:"nextSince,omitempty"`
	NextSinceID string `json:"nextSinceId,omitempty"`
}

// Sync returns one page of the account state: the full list of its chats
// and the messages and tombstones that changed since the given timestamp,
// bounded by limit per list. NextSince carries the cursor for the next
// page (empty when no list is full); the client loops on it until it is
// empty. Page overlap at the cursor is idempotent downstream (upsert by
// id), so resuming with >= never loses or duplicates rows.
//
// Storage failures are returned, never an empty page: emptiness means "end
// of history" to the client, which could then wrongly discard its cache.
func (s *Service) Sync(ctx context.Context, userID string, since time.Time, sinceID string, limit int) (SyncResponse, error) {
	if _, err := s.store.EnsureSelfChat(ctx, userID); err != nil {
		log().Error("failed to ensure self-chat", "err", err)
	}

	chats := s.store.GetUserChats(ctx, userID)

	chatIDs, memberIDs := collectChatAndMemberIDs(chats)

	nicks := s.store.GetUsersByIDs(ctx, memberIDs)

	onlineStatus := make(map[string]bool, len(memberIDs))
	for _, id := range memberIDs {
		onlineStatus[id] = s.store.IsOnline(id)
	}

	msgPage, err := s.store.MessagesChangedSince(ctx, chatIDs, since, sinceID, limit)
	if err != nil {
		return SyncResponse{}, err
	}
	messages := msgPage.Rows
	if messages == nil {
		messages = []model.Message{}
	}

	threadPage, err := s.store.ThreadMessagesChangedSince(ctx, chatIDs, since, sinceID, limit)
	if err != nil {
		return SyncResponse{}, err
	}
	threadMessages := threadPage.Rows
	if threadMessages == nil {
		threadMessages = []model.Message{}
	}

	deletedMessages, deletedPage, err := s.buildDeletedMessages(ctx, chatIDs, since, sinceID, limit)
	if err != nil {
		return SyncResponse{}, err
	}

	deletedChats, chatsPage, err := s.buildDeletedChats(ctx, userID, since, sinceID, limit)
	if err != nil {
		return SyncResponse{}, err
	}

	nextSince, nextSinceID := nextSyncCursor(
		cursorPage{msgPage.NextSince, msgPage.NextID, msgPage.HasMore},
		cursorPage{threadPage.NextSince, threadPage.NextID, threadPage.HasMore},
		cursorPage{deletedPage.NextSince, deletedPage.NextID, deletedPage.HasMore},
		cursorPage{chatsPage.NextSince, chatsPage.NextID, chatsPage.HasMore},
	)

	return SyncResponse{
		ServerNow:       time.Now().UTC(),
		Chats:           s.buildChats(ctx, chats, nicks),
		Messages:        messages,
		ThreadMessages:  threadMessages,
		DeletedMessages: deletedMessages,
		DeletedChats:    deletedChats,
		OnlineStatus:    onlineStatus,
		NextSince:       nextSince,
		NextSinceID:     nextSinceID,
	}, nil
}

// cursorPage is one paged list's contribution to the combined next cursor.
type cursorPage struct {
	cursor   time.Time
	cursorID string
	hasMore  bool
}

// nextSyncCursor is the minimum keyset cursor over the full lists: the
// resume position (time, id) of the list that ran out first. Empty when
// every list fit in one page: the client stops paging. Resuming from the
// minimum redelivers the tail of the shorter lists, which is harmless
// because every application is idempotent; the (time, id) keyset itself
// never repeats or skips a row.
func nextSyncCursor(pages ...cursorPage) (string, string) {
	var best *cursorPage
	for i := range pages {
		page := &pages[i]
		if !page.hasMore {
			continue
		}
		if best == nil || page.cursor.Before(best.cursor) ||
			(page.cursor.Equal(best.cursor) && page.cursorID < best.cursorID) {

			best = page
		}
	}
	if best == nil {
		return "", ""
	}
	return best.cursor.UTC().Format(time.RFC3339), best.cursorID
}

// ParseSince parses an RFC3339 since timestamp from a query parameter, falling
// back to the epoch when blank.
func ParseSince(sinceStr string) (time.Time, error) {
	if sinceStr == "" {
		sinceStr = syncDefaultSince
	}

	return time.Parse(time.RFC3339, sinceStr)
}

// buildChats returns the full list of the user's chats.
//
// The list is deliberately not a delta. A "changed since" query cannot see
// the changes that matter most offline: a group the user joined, a group that
// was renamed, a member that was added or removed — none of them change the
// creation date of the chat. The list holds only the chats the user belongs
// to, so sending it whole is cheap and leaves no gap.
func (s *Service) buildChats(ctx context.Context, chats []*model.Chat, nicks map[string]string) []SyncChatDTO {
	if len(chats) == 0 {
		return []SyncChatDTO{}
	}

	out := make([]SyncChatDTO, 0, len(chats))

	for _, chat := range chats {
		dto := SyncChatDTO{
			ID:        chat.ID,
			Type:      chat.Type,
			Name:      chat.Name,
			OwnerID:   chat.OwnerID,
			Members:   s.collectMembers(ctx, chat, nicks),
			CreatedAt: chat.CreatedAt,
		}

		if chat.AvatarFileID != "" {
			if f, err := s.store.GetFile(ctx, chat.AvatarFileID); err == nil {
				dto.AvatarURL = f.ToFileInfo().URL
			}
		}

		out = append(out, dto)
	}

	return out
}

func (s *Service) buildDeletedMessages(
	ctx context.Context,
	chatIDs []string,
	since time.Time,
	sinceID string,
	limit int,
) ([]SyncDeletedMessageDTO, store.DeltaPage[model.DeletedMessage], error) {

	page, err := s.store.DeletedMessagesSince(ctx, chatIDs, since, sinceID, limit)
	if err != nil {
		return nil, store.DeltaPage[model.DeletedMessage]{}, err
	}
	tombs := page.Rows
	if len(tombs) == 0 {
		return []SyncDeletedMessageDTO{}, store.DeltaPage[model.DeletedMessage]{}, nil
	}

	out := make([]SyncDeletedMessageDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, SyncDeletedMessageDTO{
			ChatID:    t.ChatID,
			MessageID: t.MessageID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out, page, nil
}

func (s *Service) buildDeletedChats(
	ctx context.Context,
	userID string,
	since time.Time,
	sinceID string,
	limit int,
) ([]SyncDeletedChatDTO, store.DeltaPage[model.DeletedChat], error) {

	page, err := s.store.DeletedChatsSince(ctx, userID, since, sinceID, limit)
	if err != nil {
		return nil, store.DeltaPage[model.DeletedChat]{}, err
	}
	tombs := page.Rows
	if len(tombs) == 0 {
		return []SyncDeletedChatDTO{}, store.DeltaPage[model.DeletedChat]{}, nil
	}

	out := make([]SyncDeletedChatDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, SyncDeletedChatDTO{
			ChatID:    t.ChatID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out, page, nil
}

func (s *Service) collectMembers(
	_ context.Context,
	chat *model.Chat,
	nicks map[string]string,
) []MemberView {

	out := make([]MemberView, 0, len(chat.Members))

	for _, member := range chat.Members {
		nick, ok := nicks[member]
		if !ok {
			nick = member
		}

		out = append(out, MemberView{ID: member, Nick: nick, Online: s.store.IsOnline(member)})
	}

	return out
}
