package service

import (
	"context"
	"errors"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"fast_chat/model"
	"fast_chat/sse"
)

const (
	groupNameMaxLen = 60
	maxGroupMembers = 100
)

// Realtime event names and event payload keys shared across the chat domain.
const (
	eventUserStatusChanged = "user_status_changed"
	eventChatCreated       = "chat_created"
	eventChatUpdated       = "chat_updated"
	eventChatDeleted       = "chat_deleted"
	eventChatMemberAdded   = "chat_member_added"
	eventChatMemberRemoved = "chat_member_removed"

	keyUserID = "userId"
	keyChatID = "chatId"
	keyOnline = "online"
	keyChat   = "chat"
)

// Chat domain errors. Handlers map a specific error to an HTTP status and a
// stable user-facing message; the service never depends on the transport.
var (
	ErrChatNotFound     = errors.New("chat not found")
	ErrWithUserRequired = errors.New("withUserId required for private chat")
	ErrChatWithSelf     = errors.New("cannot chat with yourself")
	ErrUserNotFound     = errors.New("user not found")
	ErrGroupNameInvalid = errors.New("group name must be 1-60 characters")
	ErrTooManyMembers   = errors.New("too many members")
	ErrGroupRemoteMemb  = errors.New("group chat members must be on the same server")
	ErrUserIDRequired   = errors.New("userId required")
	ErrRemoteMember     = errors.New("members must be on the same server")
	ErrFileIDRequired   = errors.New("fileId required")
	ErrFileNotFound     = errors.New("file not found")
)

// GroupMemberNotFoundError carries the offending member ID so the transport
// can echo it back verbatim ("user not found: <id>").
type GroupMemberNotFoundError struct{ ID string }

func (e *GroupMemberNotFoundError) Error() string { return "user not found: " + e.ID }

// MemberView is the transport-neutral member descriptor used by chat views
// and SSE events.
type MemberView struct {
	ID     string `json:"id"`
	Nick   string `json:"nick"`
	Online bool   `json:"online,omitempty"`
}

// ChatView is the transport-neutral enriched chat descriptor. Its JSON shape
// matches the pre-migration handler DTO so SSE events and HTTP payloads stay
// byte-identical during the migration.
type ChatView struct {
	ID        string       `json:"id"`
	Type      string       `json:"type"`
	Name      string       `json:"name"`
	OwnerID   string       `json:"ownerId"`
	AvatarURL string       `json:"avatarUrl,omitempty"`
	Members   []MemberView `json:"members"`
	CreatedAt time.Time    `json:"createdAt"`
}

// IsMember reports whether userID is a member of chat.
func IsMember(chat *model.Chat, userID string) bool {
	return slices.Contains(chat.Members, userID)
}

// IsOwner reports whether userID owns chat.
func IsOwner(chat *model.Chat, userID string) bool {
	return chat.OwnerID != "" && chat.OwnerID == userID
}

// Chat loads a chat by ID.
func (s *Service) Chat(ctx context.Context, chatID string) (*model.Chat, error) {
	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return nil, ErrChatNotFound
	}

	return chat, nil
}

// EnrichChatFromNicks builds a ChatView, resolving avatar URL, member nicks
// and online status from the store. When nicks is non-nil it is used as a
// ready-made nick lookup (skipping per-member DB queries).
func (s *Service) EnrichChatFromNicks(ctx context.Context, chat *model.Chat, nicks map[string]string) ChatView {
	view := ChatView{
		ID:        chat.ID,
		Type:      chat.Type,
		Name:      chat.Name,
		OwnerID:   chat.OwnerID,
		CreatedAt: chat.CreatedAt,
	}

	if chat.AvatarFileID != "" {
		if f, err := s.store.GetFile(ctx, chat.AvatarFileID); err == nil {
			view.AvatarURL = f.ToFileInfo().URL
		}
	}

	for _, member := range chat.Members {
		nick, ok := nicks[member]
		if !ok {
			if nicks != nil {
				nick = member
			} else if u, found := s.store.GetUserByID(ctx, member); found {
				nick = u.Nick
			} else {
				nick = member
			}
		}

		view.Members = append(view.Members, MemberView{ID: member, Nick: nick, Online: s.store.IsOnline(member)})
	}

	return view
}

// EnrichChat builds a ChatView resolving member data from the store.
func (s *Service) EnrichChat(ctx context.Context, c *model.Chat) ChatView {
	return s.EnrichChatFromNicks(ctx, c, nil)
}

// GetChats returns the enriched views of all chats a user belongs to.
func (s *Service) GetChats(ctx context.Context, userID string) []ChatView {
	chats := s.store.GetUserChats(ctx, userID)

	_, memberIDs := collectChatAndMemberIDs(chats)

	nicks := s.store.GetUsersByIDs(ctx, memberIDs)

	out := make([]ChatView, 0, len(chats))
	for _, c := range chats {
		out = append(out, s.EnrichChatFromNicks(ctx, c, nicks))
	}

	return out
}

// BroadcastUserStatus notifies all chat partners of a user's online status.
func (s *Service) BroadcastUserStatus(ctx context.Context, userID string, online bool) {
	chats := s.store.GetUserChats(ctx, userID)
	notified := make(map[string]bool)

	for _, chat := range chats {
		for _, memberID := range chat.Members {
			if memberID != userID && !notified[memberID] {
				s.sendEvent(memberID, sse.Event{
					Event: eventUserStatusChanged,
					Data: map[string]any{
						keyUserID: userID,
						keyOnline: online,
					},
				})
				notified[memberID] = true
			}
		}
	}
}

// CreatePrivateChat builds a direct chat between two users. Federated peers
// are resolved by their ID; local peers are validated to exist. The returned
// view is the enriched chat ready for the transport response.
func (s *Service) CreatePrivateChat(ctx context.Context, userID, withUserID string) (ChatView, error) {
	if withUserID == "" {
		return ChatView{}, ErrWithUserRequired
	}

	if withUserID == userID {
		return ChatView{}, ErrChatWithSelf
	}

	remoteServer := s.remoteServerFromID(withUserID)
	if remoteServer == s.cfg.Server.Domain {
		remoteServer = ""
	}

	if remoteServer == "" {
		if _, ok := s.store.GetUserByID(ctx, withUserID); !ok {
			return ChatView{}, ErrUserNotFound
		}
	}

	chat, err := s.store.CreateChat(ctx, userID, withUserID, remoteServer)
	if err != nil {
		return ChatView{}, err
	}

	view := s.EnrichChat(ctx, chat)
	s.sendEvent(userID, sse.Event{Event: eventChatCreated, Data: view})

	if remoteServer == "" {
		s.sendEvent(withUserID, sse.Event{Event: eventChatCreated, Data: view})
	}

	return view, nil
}

// CreateGroupChat validates and creates a group chat, then notifies all
// members over the realtime hub. Group members must be local to this server.
func (s *Service) CreateGroupChat(ctx context.Context, ownerID, name string, memberIDs []string) (ChatView, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > groupNameMaxLen {
		return ChatView{}, ErrGroupNameInvalid
	}

	if len(memberIDs) > maxGroupMembers {
		return ChatView{}, ErrTooManyMembers
	}

	seen := make(map[string]struct{}, len(memberIDs)+1)
	cleaned := make([]string, 0, len(memberIDs)+1)

	for _, memberID := range memberIDs {
		if memberID == "" {
			continue
		}

		if _, ok := seen[memberID]; ok {
			continue
		}

		seen[memberID] = struct{}{}
		cleaned = append(cleaned, memberID)
	}

	for _, memberID := range cleaned {
		remoteServer := s.remoteServerFromID(memberID)
		if remoteServer != "" && remoteServer != s.cfg.Server.Domain {
			return ChatView{}, ErrGroupRemoteMemb
		}

		if _, ok := s.store.GetUserByID(ctx, memberID); !ok {
			return ChatView{}, &GroupMemberNotFoundError{ID: memberID}
		}
	}

	chat, err := s.store.CreateGroupChat(ctx, name, ownerID, cleaned, "")
	if err != nil {
		return ChatView{}, err
	}

	view := s.EnrichChat(ctx, chat)
	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatCreated, Data: view})
	}

	return view, nil
}

// UpdateChatName trims, validates and persists a group chat name, then
// notifies all members, returning the enriched view for the transport response.
func (s *Service) UpdateChatName(ctx context.Context, chatID, name string) (ChatView, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > groupNameMaxLen {
		return ChatView{}, ErrGroupNameInvalid
	}

	updated, err := s.store.UpdateChatName(ctx, chatID, name)
	if err != nil {
		return ChatView{}, err
	}

	view := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: view})
	}

	return view, nil
}

// DeleteChat removes a chat and notifies all former members.
func (s *Service) DeleteChat(ctx context.Context, chat *model.Chat) error {
	if err := s.store.DeleteChat(ctx, chat.ID); err != nil {
		return err
	}

	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatDeleted, Data: map[string]string{keyChatID: chat.ID}})
	}

	return nil
}

// AddChatMember validates the invitee, adds them to the group and notifies
// all members.
func (s *Service) AddChatMember(ctx context.Context, chatID, userID string) (ChatView, error) {
	if userID == "" {
		return ChatView{}, ErrUserIDRequired
	}

	remoteServer := s.remoteServerFromID(userID)
	if remoteServer != "" && remoteServer != s.cfg.Server.Domain {
		return ChatView{}, ErrRemoteMember
	}

	if _, ok := s.store.GetUserByID(ctx, userID); !ok {
		return ChatView{}, ErrUserNotFound
	}

	if err := s.store.AddChatMember(ctx, chatID, userID, maxGroupMembers); err != nil {
		return ChatView{}, err
	}

	updated, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ChatView{}, ErrChatNotFound
	}

	view := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatMemberAdded, Data: map[string]any{
			keyChatID: chatID,
			keyUserID: userID,
			keyChat:   view,
		}})
	}

	return view, nil
}

// RemoveChatMember removes a member (or lets them leave) and notifies the
// group; the removed peer also receives a chat_deleted tombstone.
func (s *Service) RemoveChatMember(ctx context.Context, chatID, targetUserID, actorID string) (ChatView, error) {
	if err := s.store.RemoveChatMember(ctx, chatID, targetUserID); err != nil {
		return ChatView{}, err
	}

	updated, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ChatView{}, ErrChatNotFound
	}

	view := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatMemberRemoved, Data: map[string]any{
			keyChatID: chatID,
			keyUserID: targetUserID,
			keyChat:   view,
			"isLeave": targetUserID == actorID,
		}})
	}

	s.sendEvent(targetUserID, sse.Event{Event: eventChatDeleted, Data: map[string]string{keyChatID: chatID}})

	return view, nil
}

// UpdateChatAvatar validates the file reference, persists it as the group
// avatar and notifies all members.
func (s *Service) UpdateChatAvatar(ctx context.Context, chatID, fileID string) (ChatView, error) {
	if fileID == "" {
		return ChatView{}, ErrFileIDRequired
	}

	if _, err := s.store.GetFile(ctx, fileID); err != nil {
		return ChatView{}, ErrFileNotFound
	}

	updated, err := s.store.UpdateChatAvatar(ctx, chatID, fileID)
	if err != nil {
		return ChatView{}, err
	}

	view := s.EnrichChat(ctx, updated)
	for _, memberID := range updated.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatUpdated, Data: view})
	}

	return view, nil
}

// collectChatAndMemberIDs returns the deduplicated chat and member ID lists
// for a set of chats. Duplicated in sync (A6) until the sync domain is
// ported to the service layer.
func collectChatAndMemberIDs(chats []*model.Chat) ([]string, []string) {
	seenChats := make(map[string]struct{}, len(chats))
	chatIDs := make([]string, 0, len(chats))

	for _, chat := range chats {
		if _, ok := seenChats[chat.ID]; ok {
			continue
		}

		seenChats[chat.ID] = struct{}{}
		chatIDs = append(chatIDs, chat.ID)
	}

	seenMembers := make(map[string]struct{}, len(chats)*2)
	memberIDs := make([]string, 0, len(chats)*2)

	for _, chat := range chats {
		for _, member := range chat.Members {
			if _, ok := seenMembers[member]; ok {
				continue
			}

			seenMembers[member] = struct{}{}
			memberIDs = append(memberIDs, member)
		}
	}

	return chatIDs, memberIDs
}

// RemoteServerFromID extracts the server domain from a federated user ID
// ("nick:domain"). Moved here from handler/federation.go; remaining local
// callers (keys/typing) will follow in later migration steps.
func RemoteServerFromID(id string) string {
	if idx := strings.Index(id, ":"); idx != -1 && idx < len(id)-1 {
		domain := id[idx+1:]
		if _, err := url.Parse("//" + domain); err != nil {
			return ""
		}

		if strings.ContainsAny(domain, "/@?#") {
			return ""
		}

		if !IsValidRemoteDomain(domain) {
			return ""
		}

		return domain
	}

	return ""
}

// IsValidRemoteDomain rejects loopback, private and link-local targets so
// federated URLs can never be pointed at internal infrastructure.
//
// The input may carry a port ("example.com:8080", "127.0.0.1:8080",
// "[::1]:8080"): only the host part is validated. Numeric IP bypasses in
// decimal, octal, hexadecimal and single-integer (inet_aton) forms are
// resolved to the address they denote before the check.
//
// Production default denies private targets. Local multi-instance setups and
// the federation integration harness opt in via
// config Federation.AllowPrivateAddresses and the *WithOverride helpers below.
func IsValidRemoteDomain(domain string) bool {
	return IsValidRemoteDomainFor(domain, false)
}

// IsValidRemoteDomainFor is IsValidRemoteDomain with an explicit override for
// private targets. allowPrivate lifts only the IP-range check (loopback,
// private, link-local, unspecified, multicast, localhost name); syntactic
// checks (empty host, userinfo, path, query) always apply.
func IsValidRemoteDomainFor(domain string, allowPrivate bool) bool {
	host := remoteHost(domain)
	if host == "" {
		return false
	}

	if strings.ContainsAny(host, "/@?#") {
		return false
	}

	lowered := strings.ToLower(strings.TrimSuffix(host, "."))
	if lowered == "localhost" {
		return allowPrivate
	}

	if ip := parseNumericIP(lowered); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return allowPrivate
		}
	}

	return true
}

// remoteServerFromID is the service-aware RemoteServerFromID: it honors
// cfg.Federation.AllowPrivateAddresses so loopback-based local setups keep
// working while production stays strict. Nil-safe: nil cfg means no override.
func (s *Service) remoteServerFromID(id string) string {
	return RemoteServerFromIDFor(id, s != nil && s.cfg != nil && s.cfg.Federation.AllowPrivateAddresses)
}

// RemoteServerFromIDFor is RemoteServerFromID with an explicit private-target
// override (see IsValidRemoteDomainFor).
func RemoteServerFromIDFor(id string, allowPrivate bool) string {
	if idx := strings.Index(id, ":"); idx != -1 && idx < len(id)-1 {
		domain := id[idx+1:]
		if _, err := url.Parse("//" + domain); err != nil {
			return ""
		}

		if strings.ContainsAny(domain, "/@?#") {
			return ""
		}

		if !IsValidRemoteDomainFor(domain, allowPrivate) {
			return ""
		}

		return domain
	}

	return ""
}

// remoteHost strips a port and IPv6 brackets from a domain.
func remoteHost(domain string) string {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return ""
	}

	// Userinfo smuggling ("user@host") must never validate as the host.
	if strings.Contains(domain, "@") {
		return ""
	}

	if strings.HasPrefix(domain, "[") {
		if end := strings.Index(domain, "]"); end != -1 {
			return domain[1:end]
		}

		return domain
	}

	if strings.Count(domain, ":") > 1 {
		// Bare IPv6 literal without brackets or port ("::1"): url.Parse
		// would mis-split it at the last colon, so keep it as-is — but
		// only if it parses as an IP. Anything else with several colons
		// ("evil:127.0.0.1:9000", "a:b:c") is a crafted authority, not a
		// host, and must not validate as a DNS name.
		if net.ParseIP(domain) == nil {
			return ""
		}
		return domain
	}

	if u, err := url.Parse("//" + domain); err == nil {
		if h := u.Hostname(); h != "" {
			return h
		}
	}

	return domain
}

// parseNumericIP parses an IP literal including the inet_aton numeric forms
// net.ParseIP rejects: dotted octal ("0177.0.0.1"), hexadecimal
// ("0x7f.0.0.1") and single-integer ("2130706433", "0x7f000001") forms.
// Returns nil when the host is not a numeric IP (e.g. a DNS name).
//
//nolint:gosec // G115: every part is range-checked against its field width before narrowing to a byte.
func parseNumericIP(host string) net.IP {
	if ip := net.ParseIP(host); ip != nil {
		return ip
	}

	if strings.Contains(host, ":") {
		return nil
	}

	parts := strings.Split(host, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return nil
	}

	nums := make([]uint64, len(parts))

	for idx, part := range parts {
		if part == "" {
			return nil
		}

		num, err := strconv.ParseUint(strings.ToLower(part), 0, 32)
		if err != nil {
			return nil
		}

		nums[idx] = num
	}

	var addr [4]byte

	switch len(nums) {
	case 1:
		if nums[0] > 0xFFFFFFFF {
			return nil
		}

		addr[0] = byte(nums[0] >> 24)
		addr[1] = byte(nums[0] >> 16)
		addr[2] = byte(nums[0] >> 8)
		addr[3] = byte(nums[0])
	case 2:
		if nums[0] > 0xFF || nums[1] > 0xFFFFFF {
			return nil
		}

		addr[0] = byte(nums[0])
		addr[1] = byte(nums[1] >> 16)
		addr[2] = byte(nums[1] >> 8)
		addr[3] = byte(nums[1])
	case 3:
		if nums[0] > 0xFF || nums[1] > 0xFF || nums[2] > 0xFFFF {
			return nil
		}

		addr[0] = byte(nums[0])
		addr[1] = byte(nums[1])
		addr[2] = byte(nums[2] >> 8)
		addr[3] = byte(nums[2])
	case 4:
		for _, num := range nums {
			if num > 0xFF {
				return nil
			}
		}

		addr[0] = byte(nums[0])
		addr[1] = byte(nums[1])
		addr[2] = byte(nums[2])
		addr[3] = byte(nums[3])
	}

	return net.IPv4(addr[0], addr[1], addr[2], addr[3])
}
