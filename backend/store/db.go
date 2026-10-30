// Package store provides data persistence using SQLite via GORM.
package store

import (
	"fmt"
	"log/slog"
	"net/url"
	"slices"
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
//
// foreign_keys is enabled even though the schema declares no REFERENCES yet:
// it is a no-op until constraints exist, and it guarantees any constraint
// added later is enforced on every pooled connection. Until then referential
// integrity is enforced by explicit existence checks in the write paths.
func withPragmas(dsn string) string {
	base, rest, hasQuery := strings.Cut(dsn, "?")
	query := url.Values{}

	if hasQuery {
		parsed, err := url.ParseQuery(rest)
		if err != nil {
			// Keep the caller's parameters: silently dropping them would
			// swap user settings for defaults. The driver reports the
			// malformed DSN itself.
			slog.Warn("unparsable DSN query, keeping parameters as-is", "dsn", base)
			return dsn
		}
		query = parsed
	}

	addPragma := func(pragma string) {
		if slices.Contains(query["_pragma"], pragma) {
			return
		}
		query.Add("_pragma", pragma)
	}

	addPragma("journal_mode(WAL)")
	addPragma("synchronous(NORMAL)")
	addPragma("foreign_keys(1)")

	// Deduplicate: an explicit DSN value wins, otherwise pin ours.
	if _, ok := query["_txlock"]; !ok {
		query.Set("_txlock", "immediate")
	}

	// url.Values.Encode sorts keys and keeps every _pragma value, while a
	// duplicated scalar key from the input collapses to its last value via
	// the Set above.
	return base + "?" + query.Encode()
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
		&model.FederationOp{},
		&model.FederationCursor{},
	); err != nil {
		return nil, err
	}

	if err := createIndexes(db); err != nil {
		return nil, err
	}

	// Migration: delete users without email (from old registration system).
	if err := db.Where("email = '' OR email IS NULL").Delete(&model.User{}).Error; err != nil {
		return nil, fmt.Errorf("migrate users without email: %w", err)
	}

	// Migration: hash legacy plaintext tokens. Tokens are 32 hex chars
	// (16 random bytes); their SHA-256 digest is 64 hex chars. Anything
	// shorter than 64 is a legacy plaintext token and must be re-hashed
	// in place so existing sessions survive the switch to hashed storage.
	if err := migrateLegacyTokens(db); err != nil {
		return nil, fmt.Errorf("migrate legacy tokens: %w", err)
	}

	// Split the overloaded messages.chat_id into chat_id + thread_id before
	// anything queries messages by chat.
	if err := backfillMessageThreadID(db); err != nil {
		return nil, fmt.Errorf("backfill message thread ids: %w", err)
	}

	// Pin every stored timestamp to UTC before repairing: the repair compares
	// instants, and a lexicographic comparison over mixed offsets would
	// misclassify rows (e.g. an edit at 09:31-04:00 after a creation at
	// 13:30+00:00 reads as "09:31" < "13:30"). Both must run before the
	// server serves traffic: without them a catch-up sync silently omits
	// messages on hosts that are not at or east of UTC.
	if err := normalizeTimestampsToUTC(db); err != nil {
		return nil, fmt.Errorf("normalize timestamps to UTC: %w", err)
	}

	if err := repairFrozenUpdatedAt(db); err != nil {
		return nil, fmt.Errorf("repair frozen message timestamps: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}

	sqlDB.SetMaxOpenConns(maxOpenConns)

	return db, nil
}
