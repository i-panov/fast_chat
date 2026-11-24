package store

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"fast_chat/model"
)

// MigrateLegacyMasterBot moves the built-in bot from its old username to the
// current one. The bot id is `username:domain` and is referenced from several
// tables, so the rename is one transaction: a half-renamed bot would lose its
// chats and updates.
//
// The migration is a no-op when the new account already exists or the legacy
// one never did.
const colBotID = "bot_id"

// ErrMasterBotNameTaken reports that the new built-in bot name belongs to an
// account that is not the built-in bot. The server must not adopt it.
var ErrMasterBotNameTaken = errors.New("root_bot is already used by another account")

func (s *Store) MigrateLegacyMasterBot(ctx context.Context, legacyID, newID, username, displayName string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&struct{}{}).Table("users").Where("id = ?", newID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			// The name is already taken. Only the real built-in bot may
			// keep it; a human account or another user's bot must not be
			// silently adopted.
			var user model.User
			if err := tx.Where("id = ?", newID).First(&user).Error; err != nil {
				return err
			}
			if !user.IsBot {
				return ErrMasterBotNameTaken
			}
			var bot model.Bot
			if err := tx.Where("user_id = ?", newID).First(&bot).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					// A bot account without its row can be repaired by
					// EnsureMasterBot instead of blocking startup.
					return nil
				}

				return err
			}
			if !bot.IsMaster {
				return ErrMasterBotNameTaken
			}

			return nil
		}
		if err := tx.Model(&struct{}{}).Table("users").Where("id = ?", legacyID).Count(&count).Error; err != nil {
			return err
		}
		if count == 0 {
			return nil
		}

		if err := tx.Exec(
			"UPDATE users SET id = ?, username = ?, display_name = ? WHERE id = ?",
			newID, username, displayName, legacyID,
		).Error; err != nil {
			return err
		}

		references := []struct{ table, column string }{
			{"sessions", colUserID},
			{"chat_members", colUserID},
			{"messages", "from_id"},
			{"files", "uploaded_by"},
			{"chat_pins", "pinned_by"},
			{"message_reactions", colUserID},
			{"user_devices", colUserID},
			{"push_subscriptions", colUserID},
			{"user_blocks", "blocker_id"},
			{"user_blocks", "blocked_id"},
			{"deleted_chats", colUserID},
			{"message_read_statuses", colUserID},
			{"bot_father_states", colUserID},
			{"bots", colUserID},
			{"bot_chats", colBotID},
			{"bot_updates", colBotID},
			{"bot_callback_queries", colBotID},
			{"bot_callback_queries", colUserID},
			{"chats", colBotID},
		}
		for _, ref := range references {
			// Older databases may predate some of the tables; a missing one
			// cannot contain a reference to the bot.
			if !tx.Migrator().HasTable(ref.table) {
				continue
			}
			query := "UPDATE " + ref.table + " SET " + ref.column + " = ? WHERE " + ref.column + " = ?"
			if err := tx.Exec(query, newID, legacyID).Error; err != nil {
				return err
			}
		}

		return nil
	})
}
