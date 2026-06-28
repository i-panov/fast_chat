package handler

import (
	"net/http"
	"time"

	"fast_chat/model"
)

const syncDefaultSince = "1970-01-01T00:00:00Z"

type syncChatDTO struct {
	ID        string       `json:"id"`
	Type      string       `json:"type"`
	Name      string       `json:"name"`
	OwnerID   string       `json:"ownerId"`
	AvatarURL string       `json:"avatarUrl,omitempty"`
	Members   []memberInfo `json:"members"`
	CreatedAt time.Time    `json:"createdAt"`
}

type syncDeletedMessageDTO struct {
	ChatID    string    `json:"chatId"`
	MessageID string    `json:"messageId"`
	DeletedAt time.Time `json:"deletedAt"`
}

type syncDeletedChatDTO struct {
	ChatID    string    `json:"chatId"`
	DeletedAt time.Time `json:"deletedAt"`
}

type syncResponse struct {
	ServerNow       time.Time               `json:"serverNow"`
	Chats           []syncChatDTO           `json:"chats"`
	DeletedChats    []syncDeletedChatDTO    `json:"deletedChats"`
	Messages        []model.Message         `json:"messages"`
	DeletedMessages []syncDeletedMessageDTO `json:"deletedMessages"`
}

// Sync returns the delta of chats, messages, and tombstones that have
// changed for the authenticated user since the given RFC3339
// timestamp. The client uses this to bring its local IndexedDB cache
// up to date after a period of being offline.
func (h *Handler) Sync(w http.ResponseWriter, r *http.Request) {
	user := getUser(r)

	since, err := parseSince(r.URL.Query().Get("since"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid since timestamp")

		return
	}

	chats := h.store.GetUserChats(user.ID)

	chatIDs, memberIDs := collectChatAndMemberIDs(chats)

	nicks := h.store.GetUsersByIDs(memberIDs)

	resp := syncResponse{
		ServerNow:       time.Now().UTC(),
		Chats:           h.buildChangedChats(user.ID, since, nicks),
		Messages:        h.store.MessagesChangedSince(chatIDs, since),
		DeletedMessages: h.buildDeletedMessages(chatIDs, since),
		DeletedChats:    h.buildDeletedChats(user.ID, since),
	}

	writeJSON(w, http.StatusOK, resp)
}

func parseSince(sinceStr string) (time.Time, error) {
	if sinceStr == "" {
		sinceStr = syncDefaultSince
	}

	return time.Parse(time.RFC3339, sinceStr)
}

func collectChatAndMemberIDs(chats []*model.Chat) ([]string, []string) {
	seenChats := make(map[string]struct{}, len(chats))
	chatIDs := make([]string, 0, len(chats))

	for _, c := range chats {
		if _, ok := seenChats[c.ID]; ok {
			continue
		}

		seenChats[c.ID] = struct{}{}
		chatIDs = append(chatIDs, c.ID)
	}

	seenMembers := make(map[string]struct{}, len(chats)*2)
	memberIDs := make([]string, 0, len(chats)*2)

	for _, c := range chats {
		for _, m := range c.Members {
			if _, ok := seenMembers[m]; ok {
				continue
			}

			seenMembers[m] = struct{}{}
			memberIDs = append(memberIDs, m)
		}
	}

	return chatIDs, memberIDs
}

func (h *Handler) buildChangedChats(userID string, since time.Time, nicks map[string]string) []syncChatDTO {
	changed := h.store.ChatChangedSince(userID, since)
	if len(changed) == 0 {
		return nil
	}

	out := make([]syncChatDTO, 0, len(changed))

	for _, c := range changed {
		dto := syncChatDTO{
			ID:        c.ID,
			Type:      c.Type,
			Name:      c.Name,
			OwnerID:   c.OwnerID,
			Members:   h.collectMembers(c, nicks),
			CreatedAt: c.CreatedAt,
		}

		if c.AvatarFileID != "" {
			if f, err := h.store.GetFile(c.AvatarFileID); err == nil {
				dto.AvatarURL = f.ToFileInfo().URL
			}
		}

		out = append(out, dto)
	}

	return out
}

func (h *Handler) buildDeletedMessages(chatIDs []string, since time.Time) []syncDeletedMessageDTO {
	tombs := h.store.DeletedMessagesSince(chatIDs, since)
	if len(tombs) == 0 {
		return nil
	}

	out := make([]syncDeletedMessageDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, syncDeletedMessageDTO{
			ChatID:    t.ChatID,
			MessageID: t.MessageID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out
}

func (h *Handler) buildDeletedChats(userID string, since time.Time) []syncDeletedChatDTO {
	tombs := h.store.DeletedChatsSince(userID, since)
	if len(tombs) == 0 {
		return nil
	}

	out := make([]syncDeletedChatDTO, 0, len(tombs))

	for _, t := range tombs {
		out = append(out, syncDeletedChatDTO{
			ChatID:    t.ChatID,
			DeletedAt: t.DeletedAt,
		})
	}

	return out
}

func (h *Handler) collectMembers(c *model.Chat, nicks map[string]string) []memberInfo {
	out := make([]memberInfo, 0, len(c.Members))

	for _, member := range c.Members {
		nick, ok := nicks[member]
		if !ok {
			nick = member
		}

		out = append(out, memberInfo{ID: member, Nick: nick, Online: h.store.IsOnline(member)})
	}

	return out
}
