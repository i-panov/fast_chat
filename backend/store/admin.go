package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"

	"fast_chat/internal/ids"
	"fast_chat/model"
)

// The moderation queries live apart from the user-facing store methods: they
// deliberately bypass membership and ownership checks, so every caller must
// be an administrator at the service layer.

// ErrLastAdmin refuses an update that would leave the instance without an
// active administrator. It is checked inside the same transaction as the
// update, so two concurrent demotions cannot both pass the count.
var ErrLastAdmin = errors.New("cannot remove the last administrator")

const (
	adminPageSize  = 100
	whereRemoteSet = "remote_server <> ''"
)

func adminLimit(limit int) int {
	if limit <= 0 || limit > adminPageSize {
		return adminPageSize
	}

	return limit
}

// AdminListUsers returns a page of users matching the query by username,
// display name or email. It includes bots: moderating a bot starts with
// finding it.
func (s *Store) AdminListUsers(ctx context.Context, query string, limit, offset int) ([]model.User, int64, error) {
	builder := s.db.WithContext(ctx).Model(&model.User{})
	if trimmed := strings.TrimSpace(query); trimmed != "" {
		like := "%" + trimmed + "%"
		builder = builder.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ?", like, like, like)
	}

	var total int64
	if err := builder.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var users []model.User
	if err := builder.Order("username ASC").Limit(adminLimit(limit)).Offset(max(offset, 0)).Find(&users).Error; err != nil {
		return nil, 0, err
	}

	return users, total, nil
}

// AdminSetUserAdmin grants or revokes the administrator role. The last-admin
// check and the update share one transaction.
func (s *Store) AdminSetUserAdmin(ctx context.Context, userID string, admin bool, audit *model.AdminAuditLog) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target model.User
		if err := tx.Where("id = ?", userID).First(&target).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrUserNotFound
			}

			return err
		}

		if !admin && target.IsAdmin && !target.Banned {
			active, err := countOtherAdmins(tx, userID)
			if err != nil {
				return err
			}
			if active == 0 {
				return ErrLastAdmin
			}
		}

		if err := tx.Model(&model.User{}).Where("id = ?", userID).
			Update("is_admin", admin).Error; err != nil {
			return err
		}

		return insertAuditTx(tx, audit)
	})
}

// countOtherAdmins counts active administrators except the target, inside the
// caller's transaction.
func countOtherAdmins(tx *gorm.DB, excludeID string) (int64, error) {
	var count int64
	err := tx.Model(&model.User{}).
		Where("is_admin = ? AND banned = ? AND id <> ?", true, false, excludeID).
		Count(&count).Error

	return count, err
}

// AdminSetUserBanned bans or unbans an account. A ban revokes every session in
// the same transaction: leaving a live token behind would let the banned
// account keep reading and writing.
func (s *Store) AdminSetUserBanned(ctx context.Context, userID string, banned bool, audit *model.AdminAuditLog) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target model.User
		if err := tx.Where("id = ?", userID).First(&target).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrUserNotFound
			}

			return err
		}

		if banned && target.IsAdmin && !target.Banned {
			active, err := countOtherAdmins(tx, userID)
			if err != nil {
				return err
			}
			if active == 0 {
				return ErrLastAdmin
			}
		}

		if err := tx.Model(&model.User{}).Where("id = ?", userID).
			Update("banned", banned).Error; err != nil {
			return err
		}
		if !banned {
			// Restore only the bots the ban itself disabled: a bot the owner
			// switched off earlier must stay off.
			if err := tx.Model(&model.Bot{}).
				Where("owner_id = ? AND disabled_by_ban = ?", userID, true).
				Updates(map[string]any{fieldIsActive: true, "disabled_by_ban": false}).Error; err != nil {
				return err
			}
			return insertAuditTx(tx, audit)
		}

		// Bots keep their own API token and bypass the user session check:
		// disabling the owned bots closes that write path too.
		if err := tx.Model(&model.Bot{}).Where("owner_id = ? AND is_active = ?", userID, true).
			Updates(map[string]any{fieldIsActive: false, "disabled_by_ban": true}).Error; err != nil {
			return err
		}

		// The same cleanup as logout-all: sessions, push subscriptions and
		// device keys. A surviving push subscription would keep notifying a
		// banned account with message previews.
		if _, err := revokeAllSessionsTx(tx, userID, time.Now().UTC()); err != nil {
			return err
		}

		return insertAuditTx(tx, audit)
	})
}

// AdminListChats returns a page of chats matching the query by name or id,
// including federated replicas.
func (s *Store) AdminListChats(ctx context.Context, query string, limit, offset int) ([]model.Chat, int64, error) {
	builder := s.db.WithContext(ctx).Model(&model.Chat{})
	if trimmed := strings.TrimSpace(query); trimmed != "" {
		like := "%" + trimmed + "%"
		builder = builder.Where("name LIKE ? OR id LIKE ?", like, like)
	}

	var total int64
	if err := builder.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var chats []model.Chat
	if err := builder.Order("created_at DESC").Limit(adminLimit(limit)).Offset(max(offset, 0)).Find(&chats).Error; err != nil {
		return nil, 0, err
	}

	return chats, total, nil
}

// AdminListBots returns every bot with its owning account.
func (s *Store) AdminListBots(ctx context.Context) ([]model.Bot, error) {
	var bots []model.Bot
	if err := s.db.WithContext(ctx).Order("created_at DESC").Find(&bots).Error; err != nil {
		return nil, err
	}

	return bots, nil
}

// AdminFederationPeers lists the remote servers this instance has exchanged
// data with: chats replicas, file placeholders, queued operations and
// catch-up cursors.
func (s *Store) AdminFederationPeers(ctx context.Context) ([]string, error) {
	seen := make(map[string]struct{})

	sources := []struct {
		model any
		where string
	}{
		{&model.Chat{}, whereRemoteSet},
		{&model.File{}, whereRemoteSet},
		{&model.FederationOp{}, whereRemoteSet},
		{&model.FederationCursor{}, whereRemoteSet},
	}
	for _, source := range sources {
		var servers []string
		if err := s.db.WithContext(ctx).Model(source.model).Where(source.where).
			Distinct().Pluck("remote_server", &servers).Error; err != nil {
			return nil, err
		}
		for _, server := range servers {
			if server != "" {
				seen[server] = struct{}{}
			}
		}
	}

	out := make([]string, 0, len(seen))
	for server := range seen {
		out = append(out, server)
	}
	sort.Strings(out)

	return out, nil
}

// insertAuditTx writes the audit row in the same transaction as the mutation:
// a committed moderation action always has its audit entry.
func insertAuditTx(tx *gorm.DB, entry *model.AdminAuditLog) error {
	if entry == nil {
		return nil
	}
	if entry.ID == "" {
		entry.ID = ids.Generate()
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}

	return tx.Create(entry).Error
}

// AdminListAudit returns the newest entries first.
func (s *Store) AdminListAudit(ctx context.Context, limit int) ([]model.AdminAuditLog, error) {
	var entries []model.AdminAuditLog
	if err := s.db.WithContext(ctx).Order("created_at DESC").Limit(adminLimit(limit)).Find(&entries).Error; err != nil {
		return nil, err
	}

	return entries, nil
}

// AdminGetUser is a small helper for the service's target validation.
func (s *Store) AdminGetUser(ctx context.Context, userID string) (*model.User, error) {
	var user model.User
	if err := s.db.WithContext(ctx).Where("id = ?", userID).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}

		return nil, err
	}

	return &user, nil
}
