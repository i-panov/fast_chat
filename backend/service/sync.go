package service

import (
	"context"
	"time"

	"fast_chat/model"
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

// SyncResponse is the delta of chats, messages, and tombstones that have
// changed for the user since the given timestamp.
type SyncResponse struct {
	ServerNow       time.Time               `json:"serverNow"`
	Chats           []SyncChatDTO           `json:"chats"`
	DeletedChats    []SyncDeletedChatDTO    `json:"deletedChats"`
	Messages        []model.Message         `json:"messages"`
	DeletedMessages []SyncDeletedMessageDTO `json:"deletedMessages"`
	OnlineStatus    map[string]bool         `json:"onlineStatus,omitempty"`
}

// Sync returns the delta of chats, messages, and tombstones that have changed
// for the user since the given RFC3339 timestamp. The client uses this to
// bring its local cache up to date after a period of being offline.
func (s *Service) Sync(ctx context.Context, userID string, since time.Time) SyncResponse {
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

	return SyncResponse{
		ServerNow:       time.Now().UTC(),
		Chats:           s.buildChangedChats(ctx, userID, since, nicks),
		Messages:        s.store.MessagesChangedSince(ctx, chatIDs, since),
		DeletedMessages: s.buildDeletedMessages(ctx, chatIDs, since),
		DeletedChats:    s.buildDeletedChats(ctx, userID, since),
		OnlineStatus:    onlineStatus,
	}
}

// ParseSince parses an RFC3339 since timestamp from a query parameter, falling
// back to the epoch when blank.
func ParseSince(sinceStr string) (time.Time, error) {
	if sinceStr == "" {
		sinceStr = syncDefaultSince
	}

	return time.Parse(time.RFC3339, sinceStr)
}

func (s *Service) buildChangedChats(
	ctx context.Context,
	userID string,
	since time.Time,
	nicks map[string]string,
) []SyncChatDTO {

	changed := s.store.ChatChangedSince(ctx, userID, since)
	if len(changed) == 0 {
		return nil
	}

	out := make([]SyncChatDTO, 0, len(changed))

	for _, chat := range changed {
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
) []SyncDeletedMessageDTO {

	tombs := s.store.DeletedMessagesSince(ctx, chatIDs, since)
	if len(tombs) == 0 {
		return nil
	}

	out := make([]SyncDeletedMessageDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, SyncDeletedMessageDTO{
			ChatID:    t.ChatID,
			MessageID: t.MessageID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out
}

func (s *Service) buildDeletedChats(
	ctx context.Context,
	userID string,
	since time.Time,
) []SyncDeletedChatDTO {

	tombs := s.store.DeletedChatsSince(ctx, userID, since)
	if len(tombs) == 0 {
		return nil
	}

	out := make([]SyncDeletedChatDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, SyncDeletedChatDTO{
			ChatID:    t.ChatID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out
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
