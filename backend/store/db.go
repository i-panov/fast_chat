// Package store provides data persistence using SQLite via GORM.
package store

import (
	"log/slog"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"fast_chat/model"
)

type ChatMember struct {
	ChatID string `gorm:"primaryKey"`
	UserID string `gorm:"primaryKey"`
}

func InitDB(dsn string) (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
		// GORM defaults to time.Now().Local() for fields it fills in itself
		// (autoCreateTime/autoUpdateTime). Stored timestamps are compared as
		// text against a UTC sync cursor, so a local-zone value would be
		// ordered by wall-clock digits instead of by instant. Explicitly
		// assigned timestamps still have to be converted by the caller.
		NowFunc: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		return nil, err
	}

	if err := db.AutoMigrate(
		&model.User{},
		&model.Chat{},
		&ChatMember{},
		&model.Message{},
		&model.Thread{},
		&model.File{},
		&model.MessageFile{},
		&model.DeletedMessage{},
		&model.DeletedChat{},
		&model.MessageReadStatus{},
		&model.PushSubscription{},
	); err != nil {
		return nil, err
	}

	if err := createIndexes(db); err != nil {
		return nil, err
	}

	// Migration: delete users without email (from old registration system).
	if err := db.Where("email = '' OR email IS NULL").Delete(&model.User{}).Error; err != nil {
		slog.Warn("failed to migrate users without email", "err", err)
	}

	// Migration: hash legacy plaintext tokens. Tokens are 32 hex chars
	// (16 random bytes); their SHA-256 digest is 64 hex chars. Anything
	// shorter than 64 is a legacy plaintext token and must be re-hashed
	// in place so existing sessions survive the switch to hashed storage.
	if err := migrateLegacyTokens(db); err != nil {
		slog.Warn("failed to migrate legacy tokens", "err", err)
	}

	// Repair messages whose updated_at was frozen to the table creation
	// instant by the old column default, then pin every stored timestamp to
	// UTC. Both must run before the server serves traffic: without them a
	// catch-up sync silently omits messages on hosts that are not at or east
	// of UTC.
	if err := repairFrozenUpdatedAt(db); err != nil {
		slog.Warn("failed to repair frozen message timestamps", "err", err)
	}

	if err := normalizeTimestampsToUTC(db); err != nil {
		slog.Warn("failed to normalize timestamps to UTC", "err", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	sqlDB.SetMaxOpenConns(4)

	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, err
	}

	if _, err := sqlDB.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return nil, err
	}

	return db, nil
}
