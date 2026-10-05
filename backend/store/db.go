// Package store provides data persistence using SQLite via GORM.
package store

import (
	"log/slog"
	"strings"
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

// maxOpenConns bounds the SQLite connection pool. The driver is pure Go and
// every connection is a goroutine with its own statement cache, so the bound
// is small on purpose.
const maxOpenConns = 4

// withPragmas puts the driver's per-connection settings into the DSN, which is
// the only place that reaches every connection the pool opens.
//
// journal_mode(WAL) belongs here rather than in a PRAGMA issued after opening:
// it takes effect only for statements that follow it, so setting it afterwards
// left every migration running in the rollback journal. Measured on a fresh
// database, same migrations: 8.36s with the pragma afterwards versus 0.21s with
// it in the DSN.
//
// _txlock=immediate makes a transaction take the write lock when it begins. A
// deferred transaction that reads and then writes has to upgrade, and under WAL
// that upgrade cannot be granted once another connection has committed: it
// fails with SQLITE_BUSY immediately, because the busy handler is not consulted
// for it. Every explicit transaction in this package reads before it writes, so
// without this a concurrent writer turns a routine join, edit or delete into
// "database is locked" for the user.
//
// synchronous(NORMAL) stops every commit from fsyncing. Under WAL, NORMAL
// cannot corrupt the database and an application crash loses nothing, since the
// WAL has already reached the operating system; what it gives up is the last
// transactions if the machine loses power. Measured over 72 commits on this
// filesystem: 67ms per commit with the default FULL versus 88us with NORMAL.
// That gap is what exhausted the busy timeout under concurrent load and turned
// waiting into "database is locked".
//
// busy_timeout is deliberately absent: the driver already applies 5000 to every
// connection it opens. TestEveryPooledConnectionCarriesTheBusyTimeout pins that
// dependency, so a driver change that drops it fails the suite.
func withPragmas(dsn string) string {
	params := []string{
		"_pragma=journal_mode%28WAL%29",
		"_pragma=synchronous%28NORMAL%29",
		"_txlock=immediate",
	}

	separator := "?"
	if strings.Contains(dsn, "?") {
		separator = "&"
	}

	return dsn + separator + strings.Join(params, "&")
}

func InitDB(dsn string) (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open(withPragmas(dsn)), &gorm.Config{
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

	// Split the overloaded messages.chat_id into chat_id + thread_id before
	// anything queries messages by chat.
	if err := backfillMessageThreadID(db); err != nil {
		slog.Warn("failed to backfill message thread ids", "err", err)
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

	sqlDB.SetMaxOpenConns(maxOpenConns)

	return db, nil
}
