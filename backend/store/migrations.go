package store

import (
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"

	"fast_chat/model"
)

// migrateLegacyTokens re-hashes plaintext bearer tokens left over from
// before tokens were stored as SHA-256 digests. It is idempotent: only
// rows whose token is not already a 64-char hex digest are touched.
func migrateLegacyTokens(db *gorm.DB) error {
	var users []model.User
	if err := db.Select("id", "token").Find(&users).Error; err != nil {
		return err
	}

	for idx := range users {
		if len(users[idx].Token) == 64 {
			continue
		}

		if err := db.Model(&model.User{}).Where("id = ?", users[idx].ID).
			Update("token", hashToken(users[idx].Token)).Error; err != nil {
			return err
		}
	}

	return nil
}

// createIndexes adds the secondary indexes that the hot read paths rely
// on. AutoMigrate only creates the primary key index, so without these
// every chat lookup, message fetch, and file-dedup query does a full
// table scan.
//
// CREATE INDEX IF NOT EXISTS is idempotent on SQLite, so this is safe
// to call on every boot.
func createIndexes(db *gorm.DB) error {
	// Files can share a hash (same content uploaded under different
	// names), so the hash index must not be unique. Older databases have
	// a UNIQUE idx_files_hash created by the model's old uniqueIndex tag;
	// drop it so the CREATE INDEX below rebuilds a plain index.
	if err := db.Exec("DROP INDEX IF EXISTS idx_files_hash").Error; err != nil {
		return err
	}

	statements := []string{
		// Messages: GetMessages / GetMessage / pagination all filter by
		// chat_id and order by (created_at, id). A composite index
		// serves both the WHERE and the ORDER BY.
		"CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at, id)",

		// ChatMember: GetUserChats looks up chats by user_id, and
		// enrichChat looks up members by chat_id. Both columns are
		// needed for the N+1 batch fix to stay cheap as the table grows.
		"CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members(chat_id)",

		// Users: the auth middleware authenticates by token on every
		// request, so it must be O(log n).
		"CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)",

		// Files: UploadFile dedupes by sha256 hash on every upload.
		"CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash)",

		// Threads: GetThreadsForChat filters by chat_id.
		"CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_id)",

		// MessageFile: batch lookups filter by message_id; ServeFile
		// authorization also joins the other way by file_id.
		"CREATE INDEX IF NOT EXISTS idx_message_files_message ON message_files(message_id)",
		"CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id)",

		// Sync delta queries scan messages and tombstones by chat_id
		// filtered by timestamp.
		"CREATE INDEX IF NOT EXISTS idx_messages_chat_updated ON messages(chat_id, updated_at)",
		"CREATE INDEX IF NOT EXISTS idx_deleted_messages_chat_time ON deleted_messages(chat_id, deleted_at)",
		"CREATE INDEX IF NOT EXISTS idx_deleted_chats_user_time ON deleted_chats(user_id, deleted_at)",

		// MessageReadStatus: batch lookups by message_id for loading
		// read statuses; user lookups for sync queries.
		"CREATE INDEX IF NOT EXISTS idx_message_read_statuses_message ON message_read_statuses(message_id)",
		"CREATE INDEX IF NOT EXISTS idx_message_read_statuses_user ON message_read_statuses(user_id)",
	}

	for _, stmt := range statements {
		if err := db.Exec(stmt).Error; err != nil {
			return err
		}
	}

	return nil
}

// repairFrozenUpdatedAt fixes messages poisoned by the `default:0` tag that
// model.Message used to carry on CreatedAt/UpdatedAt. GORM resolved that tag
// to a concrete instant while parsing the schema and then wrote it into every
// insert that omitted the fields — the whole inbound federation path, which
// builds the message itself. Those rows then failed the `updated_at >= since`
// filter of every sync delta and were never delivered to a catch-up client.
//
// The predicate is timezone-independent: a genuine edit always moves
// updated_at to at or after created_at, so only poisoned rows match.
func repairFrozenUpdatedAt(db *gorm.DB) error {
	return db.Exec("UPDATE messages SET updated_at = created_at WHERE updated_at < created_at").Error
}

// utcTimestampColumns lists every persisted timestamp that is later filtered
// or ordered by a SQL comparison, grouped by table.
//
// Timestamps are stored as text carrying a numeric UTC offset, so `>=`, `<`
// and ORDER BY on them are lexicographic over the wall-clock digits, not over
// the instant. That is only sound while every value carries the same offset as
// the bound cursor: sync deltas bind a UTC `since` (service.Sync stamps
// ServerNow in UTC), so a row written in a zone west of UTC was compared as
// "09:59:31-04:00" >= "12:59:32Z" and silently dropped. Pinning every column
// to UTC keeps those comparisons honest, and keeps idx_messages_chat_updated
// usable — wrapping the column in unixepoch() would parse each row at runtime
// and force a scan.
var utcTimestampColumns = map[string][]string{
	"messages":              {fieldCreatedAt, fieldUpdatedAt, fieldEditedAt},
	"chats":                 {fieldCreatedAt},
	"threads":               {fieldCreatedAt},
	"files":                 {fieldCreatedAt},
	"deleted_messages":      {"deleted_at"},
	"deleted_chats":         {"deleted_at"},
	"message_read_statuses": {"read_at"},
	"push_subscriptions":    {fieldCreatedAt},
	"users":                 {"token_expires_at", fieldKeyBackupAt},
}

// normalizeTimestampsToUTC rewrites stored timestamps that carry a non-zero
// offset into UTC, so databases created before this change keep comparing
// correctly against UTC cursors.
//
// A table that does not exist yet is skipped rather than treated as a failure:
// utcTimestampColumns lists every persisted timestamp, and a future schema
// change that drops or defers one must not disable the pass for the other
// columns. Real errors are still reported, aggregated.
func normalizeTimestampsToUTC(db *gorm.DB) error {
	var errs []error

	for table, columns := range utcTimestampColumns {
		if !db.Migrator().HasTable(table) {
			continue
		}

		for _, column := range columns {
			if err := normalizeTimestampColumnUTC(db, table, column); err != nil {
				errs = append(errs, fmt.Errorf("normalize %s.%s: %w", table, column, err))
			}
		}
	}

	return errors.Join(errs...)
}

// normalizeTimestampColumnUTC converts one column in place.
//
// Values the driver wrote always carry an explicit offset ("+00:00", "-04:00"
// or "Z"), so those are the only ones it can round-trip without guessing a
// zone; values with no offset at all can only be the frozen column default
// that repairFrozenUpdatedAt deals with, and are deliberately left alone.
//
// The filter matches nothing once a column is already UTC, so the pass is
// idempotent: no row is rewritten on later boots. The probe itself is still a
// scan of the column on every boot, which is why InitDB runs this before
// serving traffic rather than lazily.
func normalizeTimestampColumnUTC(db *gorm.DB, table, column string) error {
	qual := table + "." + column

	convertible := qual + " IS NOT NULL AND substr(" + qual + ", -6) <> '+00:00'" +
		" AND (substr(" + qual + ", -1) = 'Z' OR substr(" + qual + ", -6, 1) IN ('+', '-'))"

	var pendingCount int64
	if err := db.Raw("SELECT count(*) FROM " + table + " WHERE " + convertible).
		Row().Scan(&pendingCount); err != nil {
		return err
	}

	if pendingCount == 0 {
		return nil
	}

	type rewrite struct {
		rowID int64
		when  time.Time
	}

	rewrites := make([]rewrite, 0, pendingCount)

	rows, err := db.Raw("SELECT rowid, " + qual + " FROM " + table + " WHERE " + convertible).Rows()
	if err != nil {
		return err
	}

	defer rows.Close() //nolint:errcheck // best-effort: close errors are not actionable

	for rows.Next() {
		var rw rewrite

		if err := rows.Scan(&rw.rowID, &rw.when); err != nil {
			return err
		}

		if rw.when.IsZero() {
			continue
		}

		rewrites = append(rewrites, rewrite{rowID: rw.rowID, when: rw.when.UTC()})
	}

	if err := rows.Err(); err != nil {
		return err
	}

	// Release the read cursor before opening the write transaction. An
	// exhausted cursor is already closed by database/sql, but relying on that
	// would tie this to a driver detail while the pool can hand out several
	// connections; closing explicitly also documents the ordering.
	if err := rows.Close(); err != nil {
		return err
	}

	return db.Transaction(func(tx *gorm.DB) error {
		for _, rw := range rewrites {
			if err := tx.Exec("UPDATE "+table+" SET "+column+" = ? WHERE rowid = ?", rw.when, rw.rowID).Error; err != nil {
				return err
			}
		}

		return nil
	})
}
