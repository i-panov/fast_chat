package service

import (
	"context"
	"errors"

	"fast_chat/model"
	"fast_chat/sse"
	"fast_chat/store"
)

// Admin domain errors. The transport maps them to 403/400/404.
var (
	ErrAdminRequired      = errors.New("administrator role required")
	ErrAdminSelfAction    = errors.New("cannot moderate your own account")
	ErrAdminLastAdmin     = errors.New("cannot remove the last administrator")
	ErrAdminTargetInvalid = errors.New("invalid moderation target")
)

// AdminUserPage is one page of the user list.
type AdminUserPage struct {
	Users  []model.User `json:"users"`
	Total  int64        `json:"total"`
	Offset int          `json:"offset"`
	Limit  int          `json:"limit"`
}

// AdminChatPage is one page of the chat list.
type AdminChatPage struct {
	Chats  []model.Chat `json:"chats"`
	Total  int64        `json:"total"`
	Offset int          `json:"offset"`
	Limit  int          `json:"limit"`
}

// AdminBotView is a bot plus the owner data the moderation screen shows.
type AdminBotView struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"displayName"`
	OwnerID        string `json:"ownerId"`
	OwnerUsername  string `json:"ownerUsername"`
	EncryptionMode string `json:"encryptionMode"`
	IsActive       bool   `json:"isActive"`
	IsMaster       bool   `json:"isMaster"`
}

// requireAdmin re-reads the role from the database instead of trusting the
// context: a demotion must take effect on the next request, not after a new
// login.
func (s *Service) requireAdmin(ctx context.Context, actorID string) error {
	actor, ok := s.store.GetUserByID(ctx, actorID)
	if !ok || !actor.IsAdmin || actor.Banned {
		return ErrAdminRequired
	}

	return nil
}

// SyncConfiguredAdmins applies server.admins to accounts that already exist.
// Entries are e-mail addresses, not usernames: an e-mail is proven by the
// verification code before the account exists, so nobody can claim a
// configured name by registering it first. A missing account is logged; the
// administrator must register and the server restarts (the function runs at
// startup). Removing an entry does not demote the account; another
// administrator can revoke the role in /admin.
func (s *Service) SyncConfiguredAdmins(ctx context.Context) error {
	if s.cfg == nil {
		return nil
	}
	for _, configured := range s.cfg.Server.Admins {
		email := normalizeEmail(configured)
		user, ok := s.store.GetUserByEmail(ctx, email)
		if !ok {
			log().Warn("configured administrator has no account yet", "email", email)
			continue
		}
		if user.IsAdmin {
			continue
		}
		if err := s.store.AdminSetUserAdmin(ctx, user.ID, true, nil); err != nil {
			return err
		}
		log().Info("granted the administrator role from the configuration", "email", email)
	}

	return nil
}

// mapAdminStoreError translates the store sentinels into the service errors
// the transport maps to 404/409. The store and the service define their own
// sentinels, and errors.Is does not compare them across packages.
func mapAdminStoreError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, store.ErrUserNotFound):
		return ErrUserNotFound
	case errors.Is(err, store.ErrLastAdmin):
		return ErrAdminLastAdmin
	default:
		return err
	}
}

func newAuditEntry(actorID, action, targetType, targetID, detail string) *model.AdminAuditLog {
	return &model.AdminAuditLog{
		ActorID:    actorID,
		Action:     action,
		TargetType: targetType,
		TargetID:   targetID,
		Detail:     detail,
	}
}

// AdminListUsers returns a page of accounts. The role check happens in the
// service, so a transport mistake cannot expose the list.
func (s *Service) AdminListUsers(ctx context.Context, actorID, query string, limit, offset int) (AdminUserPage, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return AdminUserPage{}, err
	}

	users, total, err := s.store.AdminListUsers(ctx, query, limit, offset)
	if err != nil {
		return AdminUserPage{}, err
	}

	return AdminUserPage{Users: users, Total: total, Offset: max(offset, 0), Limit: max(limit, 0)}, nil
}

// AdminSetUserAdmin promotes or demotes an account.
func (s *Service) AdminSetUserAdmin(ctx context.Context, actorID, targetID string, admin bool) error {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return err
	}
	if targetID == actorID && !admin {
		return ErrAdminSelfAction
	}

	target, err := s.store.AdminGetUser(ctx, targetID)
	if err != nil {
		return mapAdminStoreError(err)
	}
	if target.IsBot {
		return ErrAdminTargetInvalid
	}

	entry := newAuditEntry(actorID, "user.admin", "user", targetID,
		map[bool]string{true: "granted", false: "revoked"}[admin])
	return mapAdminStoreError(s.store.AdminSetUserAdmin(ctx, targetID, admin, entry))
}

// AdminSetUserBanned bans or unbans an account. A ban also revokes the
// account's sessions inside the same transaction.
func (s *Service) AdminSetUserBanned(ctx context.Context, actorID, targetID string, banned bool) error {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return err
	}
	if targetID == actorID && banned {
		return ErrAdminSelfAction
	}

	target, err := s.store.AdminGetUser(ctx, targetID)
	if err != nil {
		return mapAdminStoreError(err)
	}
	if target.IsBot {
		return ErrAdminTargetInvalid
	}

	entry := newAuditEntry(actorID, "user.ban", "user", targetID,
		map[bool]string{true: "banned", false: "unbanned"}[banned])
	if err := s.store.AdminSetUserBanned(ctx, targetID, banned, entry); err != nil {
		return mapAdminStoreError(err)
	}
	if banned && s.hub != nil {
		// The REST session is gone, but an SSE stream already bound to it
		// would keep delivering message events until it expired.
		s.hub.CloseUserSessions(targetID)
	}

	return nil
}

// AdminListChats pages through every chat, including federated replicas.
func (s *Service) AdminListChats(ctx context.Context, actorID, query string, limit, offset int) (AdminChatPage, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return AdminChatPage{}, err
	}

	chats, total, err := s.store.AdminListChats(ctx, query, limit, offset)
	if err != nil {
		return AdminChatPage{}, err
	}

	return AdminChatPage{Chats: chats, Total: total, Offset: max(offset, 0), Limit: max(limit, 0)}, nil
}

// AdminDeleteChat removes a chat and notifies its members like a regular
// owner deletion does.
func (s *Service) AdminDeleteChat(ctx context.Context, actorID, chatID string) error {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return err
	}

	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}

	// DeleteChat is owner-facing and refuses private chats; moderation must
	// be able to remove any chat type, so the store-level admin path is used
	// and the federation fan-out is repeated here.
	domains := make(map[string]struct{})
	if chat.RemoteServer == "" && s.fed != nil {
		for _, memberID := range chat.Members {
			domain := s.remoteServerFromID(memberID)
			if domain != "" && domain != s.cfg.Server.Domain {
				domains[domain] = struct{}{}
			}
		}
	}
	entry := newAuditEntry(actorID, "chat.delete", "chat", chatID, "")
	if err := s.store.DeleteChatAsAdmin(ctx, chatID, entry); err != nil {
		return mapAdminStoreError(err)
	}
	for domain := range domains {
		groupURL := s.fed.URL(domain, "/api/federated/groups/"+chatID)
		if _, err := s.fed.Request(ctx, "DELETE", groupURL, nil); err != nil {
			log().Warn("federated group delete failed", "server", domain, "err", err)
		}
	}
	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventChatDeleted, Data: map[string]string{keyChatID: chatID}})
	}

	return nil
}

// AdminListMessages returns the newest messages of one chat.
func (s *Service) AdminListMessages(ctx context.Context, actorID, chatID string, limit int, before string) ([]model.Message, string, bool, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return nil, "", false, err
	}
	if _, ok := s.store.GetChat(ctx, chatID); !ok {
		return nil, "", false, ErrChatNotFound
	}
	// GORM treats a negative limit as "no limit", which would return the
	// whole chat; the admin page pages explicitly, so clamp it.
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	return s.store.GetMessagesPaginatedE(ctx, chatID, limit, before)
}

// AdminDeleteMessage removes a message regardless of its author.
func (s *Service) AdminDeleteMessage(ctx context.Context, actorID, chatID, messageID string) error {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return err
	}

	chat, ok := s.store.GetChat(ctx, chatID)
	if !ok {
		return ErrChatNotFound
	}
	if _, err := s.store.GetMessage(ctx, chatID, messageID); err != nil {
		return ErrMessageNotFound
	}
	entry := newAuditEntry(actorID, "message.delete", "message", messageID, "chat="+chatID)
	if err := s.store.DeleteMessageAsAdmin(ctx, chatID, messageID, entry); err != nil {
		return mapAdminStoreError(err)
	}

	// Moderation is not local: the peer that hosts the chat (or every peer in
	// a locally owned group) must delete the same message, otherwise it stays
	// visible on the other server and returns with the next catch-up.
	if s.fed != nil {
		path := "/api/federated/chats/" + chatID + "/messages/" + messageID
		if chat.RemoteServer != "" {
			s.queueFederation(ctx, chat.RemoteServer, "DELETE", path, nil)
		} else {
			seen := make(map[string]struct{})
			for _, memberID := range chat.Members {
				domain := s.remoteServerFromID(memberID)
				if domain == "" || domain == s.cfg.Server.Domain {
					continue
				}
				if _, ok := seen[domain]; ok {
					continue
				}
				seen[domain] = struct{}{}
				s.queueFederation(ctx, domain, "DELETE", path, nil)
			}
		}
	}

	for _, memberID := range chat.Members {
		s.sendEvent(memberID, sse.Event{Event: eventMessageDeleted, Data: map[string]string{keyChatID: chatID, keyMessageID: messageID}})
	}

	return nil
}

// AdminListBots returns every bot with its owner.
func (s *Service) AdminListBots(ctx context.Context, actorID string) ([]AdminBotView, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return nil, err
	}

	bots, err := s.store.AdminListBots(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]AdminBotView, 0, len(bots))
	for idx := range bots {
		user, ok := s.store.GetUserByID(ctx, bots[idx].UserID)
		if !ok {
			continue
		}
		owner, _ := s.store.GetUserByID(ctx, bots[idx].OwnerID)
		ownerName := bots[idx].OwnerID
		if owner != nil {
			ownerName = owner.Username
		}
		out = append(out, AdminBotView{
			ID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
			OwnerID: bots[idx].OwnerID, OwnerUsername: ownerName,
			EncryptionMode: bots[idx].EncryptionMode,
			IsActive:       bots[idx].IsActive, IsMaster: bots[idx].IsMaster,
		})
	}

	return out, nil
}

// AdminSetBotActive enables or disables a bot. A disabled bot rejects every
// Bot API call until an admin or the owner enables it again.
func (s *Service) AdminSetBotActive(ctx context.Context, actorID, botUserID string, active bool) error {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return err
	}
	if _, ok := s.store.GetBot(ctx, botUserID); !ok {
		return ErrUserNotFound
	}
	entry := newAuditEntry(actorID, "bot.active", "bot", botUserID,
		map[bool]string{true: "enabled", false: "disabled"}[active])
	return s.store.SetBotActive(ctx, botUserID, active, entry)
}

// AdminListFederationPeers returns the peers this instance has data from.
func (s *Service) AdminListFederationPeers(ctx context.Context, actorID string) ([]string, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return nil, err
	}

	return s.store.AdminFederationPeers(ctx)
}

// AdminListAudit returns the newest audit entries.
func (s *Service) AdminListAudit(ctx context.Context, actorID string, limit int) ([]model.AdminAuditLog, error) {
	if err := s.requireAdmin(ctx, actorID); err != nil {
		return nil, err
	}

	return s.store.AdminListAudit(ctx, limit)
}
