package store

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"fast_chat/model"
)

var (
	ErrBotNotFound         = errors.New("bot not found")
	ErrBotTokenNotFound    = errors.New("bot token not found")
	ErrBotIdentityConflict = errors.New("bot identity already configured")
	// ErrBotCallbackAlreadyAnswered marks a callback query that already has
	// an answer. Bot SDKs retry after a lost response, so this is a normal
	// conflict, not a server error.
	ErrBotCallbackAlreadyAnswered = errors.New("bot callback query already answered")
)

func (s *Store) CreateBot(ctx context.Context, bot *model.Bot, initialChat *model.Chat) error {
	now := time.Now().UTC()
	if bot.CreatedAt.IsZero() {
		bot.CreatedAt = now
	}
	bot.UpdatedAt = now
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(bot).Error; err != nil {
			return err
		}
		if initialChat == nil {
			return nil
		}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(initialChat).Error; err != nil {
			return err
		}
		return tx.Create(&model.BotChat{
			BotID: bot.UserID, UserID: bot.OwnerID,
			ChatID: initialChat.ID, CreatedAt: now,
		}).Error
	})
}

const (
	fieldIsActive = "is_active"
	// fieldDisabledByBan marks the bots a ban switched off, so an unban
	// restores exactly those and not the ones the owner turned off earlier.
	fieldDisabledByBan = "disabled_by_ban"
)

func (s *Store) GetBot(ctx context.Context, userID string) (*model.Bot, bool) {
	var bot model.Bot
	if err := s.db.WithContext(ctx).First(&bot, "user_id = ?", userID).Error; err != nil {
		return nil, false
	}
	return &bot, true
}

func (s *Store) GetBotByTokenHash(ctx context.Context, tokenHash string) (*model.Bot, bool) {
	var bot model.Bot
	if err := s.db.WithContext(ctx).
		Where("token_hash = ? AND is_active = ?", tokenHash, true).
		First(&bot).Error; err != nil {
		return nil, false
	}
	return &bot, true
}

// CountBotsByOwner reports how many bot identities an account owns.
func (s *Store) CountBotsByOwner(ctx context.Context, ownerID string) int64 {
	var count int64
	if err := s.db.WithContext(ctx).Model(&model.Bot{}).Where("owner_id = ?", ownerID).Count(&count).Error; err != nil {
		slog.Warn("CountBotsByOwner failed", "err", err)
	}
	return count
}

func (s *Store) ListBotsByOwner(ctx context.Context, ownerID string) ([]model.Bot, error) {
	var bots []model.Bot
	err := s.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("created_at ASC").
		Find(&bots).Error
	return bots, err
}

func (s *Store) UpdateBotToken(ctx context.Context, userID, tokenHash, prefix string) error {
	res := s.db.WithContext(ctx).Model(&model.Bot{}).
		Where("user_id = ?", userID).
		Updates(map[string]any{
			"token_hash": tokenHash, "token_prefix": prefix, fieldUpdatedAt: time.Now().UTC(),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrBotNotFound
	}
	return nil
}

func (s *Store) SetBotActive(ctx context.Context, userID string, active bool, audit *model.AdminAuditLog) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// An explicit state change supersedes the ban marker. Without clearing
		// it, an unban later restores a bot that an admin (or the owner) had
		// just switched off on purpose.
		if err := tx.Model(&model.Bot{}).
			Where("user_id = ?", userID).
			Updates(map[string]any{
				fieldIsActive:      active,
				fieldDisabledByBan: false,
				fieldUpdatedAt:     time.Now().UTC(),
			}).Error; err != nil {
			return err
		}

		return insertAuditTx(tx, audit)
	})
}

func (s *Store) DeleteBot(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("bot_id = ?", userID).Delete(&model.BotChat{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", userID).Delete(&model.BotUpdate{}).Error; err != nil {
			return err
		}
		if err := tx.Where("bot_id = ?", userID).Delete(&model.BotCallbackQuery{}).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ?", userID).Delete(&model.Bot{}).Error
	})
}

func (s *Store) GetBotChat(ctx context.Context, botID, userID string) (*model.BotChat, bool) {
	var chat model.BotChat
	if err := s.db.WithContext(ctx).
		Where("bot_id = ? AND user_id = ?", botID, userID).
		First(&chat).Error; err != nil {
		return nil, false
	}
	return &chat, true
}

func (s *Store) GetBotChatByChatID(ctx context.Context, chatID string) (*model.BotChat, bool) {
	var chat model.BotChat
	if err := s.db.WithContext(ctx).First(&chat, "chat_id = ?", chatID).Error; err != nil {
		return nil, false
	}
	return &chat, true
}

func (s *Store) CreateBotChat(ctx context.Context, botID, userID, chatID string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "bot_id"}, {Name: colUserID}},
		// Reopening a bot chat after the old row was deleted otherwise kept
		// the stale chat_id and every bot operation failed with "chat not
		// found" while the UI showed a fresh chat.
		DoUpdates: clause.AssignmentColumns([]string{"chat_id", "created_at"}),
	}).Create(&model.BotChat{BotID: botID, UserID: userID, ChatID: chatID, CreatedAt: time.Now().UTC()}).Error
}

func (s *Store) AppendBotUpdate(ctx context.Context, botID, updateType, payload string) (*model.BotUpdate, error) {
	update := &model.BotUpdate{BotID: botID, Type: updateType, Payload: payload, CreatedAt: time.Now().UTC()}
	if err := s.db.WithContext(ctx).Create(update).Error; err != nil {
		return nil, err
	}
	return update, nil
}

// DeleteBotUpdatesBefore acknowledges every update below offset. Telegram's
// getUpdates has the same contract; without it a restarted bot replays all
// updates retained for seven days.
func (s *Store) DeleteBotUpdatesBefore(ctx context.Context, botID string, offset uint64) error {
	if offset == 0 {
		return nil
	}

	return s.db.WithContext(ctx).
		Where("bot_id = ? AND id < ?", botID, offset).
		Delete(&model.BotUpdate{}).Error
}

func (s *Store) GetBotUpdates(ctx context.Context, botID string, offset uint64, limit int) ([]model.BotUpdate, error) {
	var updates []model.BotUpdate
	err := s.db.WithContext(ctx).
		Where("bot_id = ? AND id >= ?", botID, offset).
		Order("id ASC").Limit(limit).Find(&updates).Error
	return updates, err
}

func (s *Store) CreateBotCallbackQuery(ctx context.Context, q *model.BotCallbackQuery) error {
	return s.db.WithContext(ctx).Create(q).Error
}

func (s *Store) GetBotCallbackQuery(ctx context.Context, id, botID string) (*model.BotCallbackQuery, bool) {
	var q model.BotCallbackQuery
	if err := s.db.WithContext(ctx).Where("id = ? AND bot_id = ?", id, botID).First(&q).Error; err != nil {
		return nil, false
	}
	return &q, true
}

func (s *Store) AnswerBotCallbackQuery(ctx context.Context, id, botID, text string, showAlert bool) error {
	now := time.Now().UTC()
	res := s.db.WithContext(ctx).Model(&model.BotCallbackQuery{}).
		Where("id = ? AND bot_id = ? AND answered_at IS NULL", id, botID).
		Updates(map[string]any{
			"answered_at": now, "answer_text": text, "show_alert": showAlert,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrBotCallbackAlreadyAnswered
	}
	return nil
}

// BotUsernameValid checks the bot-specific suffix before the shared username
// validator runs.
func BotUsernameValid(username string) bool {
	username = strings.ToLower(strings.TrimSpace(username))
	if !strings.HasSuffix(username, "_bot") {
		return false
	}
	base := strings.TrimSuffix(username, "_bot")
	return len(base) >= 2 && len(base) <= 28
}

func (s *Store) GetBotFatherState(ctx context.Context, userID string) (*model.BotFatherState, bool) {
	var state model.BotFatherState
	if err := s.db.WithContext(ctx).First(&state, "user_id = ?", userID).Error; err != nil {
		return nil, false
	}
	if time.Now().After(state.ExpiresAt) {
		if err := s.DeleteBotFatherState(ctx, userID); err != nil {
			slog.Warn("failed to clear expired bot father state", "err", err)
		}
		return nil, false
	}
	return &state, true
}

func (s *Store) SetBotFatherState(ctx context.Context, state *model.BotFatherState) error {
	state.UpdatedAt = time.Now().UTC()
	state.ExpiresAt = state.UpdatedAt.Add(time.Hour)
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: colUserID}},
		DoUpdates: clause.AssignmentColumns([]string{"step", "payload", "updated_at", "expires_at"}),
	}).Create(state).Error
}

func (s *Store) DeleteBotFatherState(ctx context.Context, userID string) error {
	return s.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.BotFatherState{}).Error
}

func (s *Store) SetMessageReplyMarkup(ctx context.Context, messageID string, markup *model.InlineKeyboardMarkup) error {
	data, err := json.Marshal(markup)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).Model(&model.Message{}).
		Where("id = ?", messageID).
		Update("reply_markup", string(data)).Error
}

func (s *Store) SetBotEncryptionKey(
	ctx context.Context,
	userID, publicKey, identityPublicKey string,
	expectedVersion int,
	keyVersion int,
) error {

	if keyVersion < 1 {
		keyVersion = 1
	}
	if expectedVersion < 1 {
		expectedVersion = 1
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Bot{}).Where("user_id = ?", userID).
			Updates(map[string]any{"encryption_mode": "e2ee", "updated_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		result := tx.Model(&model.User{}).
			Where(
				"id = ? AND key_version = ? AND (public_key = ? OR public_key = '') AND (identity_public_key = '' OR identity_public_key = ?)",
				userID, expectedVersion, publicKey, identityPublicKey,
			).
			Updates(map[string]any{
				fieldPublicKey:        publicKey,
				"identity_public_key": identityPublicKey,
				"key_version":         keyVersion,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrBotIdentityConflict
		}
		return tx.Model(&model.Chat{}).Where("bot_id = ?", userID).
			Update("bot_encryption_mode", "e2ee").Error
	})
}

func (s *Store) PruneBotData(ctx context.Context, before time.Time) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("created_at < ?", before).Delete(&model.BotUpdate{}).Error; err != nil {
			return err
		}
		return tx.Where("created_at < ?", before).Delete(&model.BotCallbackQuery{}).Error
	})
}

// GetBotsByUserIDs loads bot profiles for many user ids in one query.
//
//nolint:dupl // mirrors the generic file batch loader.
func (s *Store) GetBotsByUserIDs(ctx context.Context, userIDs []string) map[string]*model.Bot {
	out := make(map[string]*model.Bot, len(userIDs))
	if len(userIDs) == 0 {
		return out
	}
	for start := 0; start < len(userIDs); start += deleteBatchIDs {
		end := min(start+deleteBatchIDs, len(userIDs))
		var bots []model.Bot
		if err := s.db.WithContext(ctx).Where("user_id IN ?", userIDs[start:end]).Find(&bots).Error; err != nil {
			slog.Warn("GetBotsByUserIDs failed", "err", err)
			continue
		}
		for idx := range bots {
			out[bots[idx].UserID] = &bots[idx]
		}
	}
	return out
}
