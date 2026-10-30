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

		// Threads: every thread-scoped read (list messages, resolve the
		// parent) filters by thread_id and orders by created_at, so it needs
		// the same composite shape as the chat index.
		"CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at, id)",

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

		// Threads: one thread per parent message. The application checks this
		// before inserting, but only a unique index makes concurrent creates
		// safe: the loser hits the constraint and maps to ErrThreadExists.
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_chat_parent ON threads(chat_id, parent_message_id)",

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

		// Chats: the federation lists the peers of this server and the chats
		// it shares with them. Both filter by remote_server, which would
		// otherwise mean a full scan of the chats table every poll.
		"CREATE INDEX IF NOT EXISTS idx_chats_remote_server ON chats(remote_server)",

		// FederationOp: the outbox picks the operations that are due and
		// checks, for every peer, that no earlier operation of that peer is
		// still waiting. The composite index serves both the barrier and the
		// ordering.
		"CREATE INDEX IF NOT EXISTS idx_federation_ops_peer_created ON federation_ops(remote_server, created_at, id)",

		// FederationOp: DueFederationOps filters by next_attempt_at on every
		// tick, so the due scan needs its own index rather than walking the
		// peer/created one.
		"CREATE INDEX IF NOT EXISTS idx_federation_ops_next_attempt ON federation_ops(next_attempt_at)",
	}

	for _, stmt := range statements {
		if err := db.Exec(stmt).Error; err != nil {
			return err
		}
	}

	return nil
}

// backfillMessageThreadID splits the overloaded messages.chat_id into the real
// chat id and a dedicated thread_id.
//
// chat_id used to hold the thread id for thread messages, which hid those rows
// from every chat-scoped query: deleting a chat left them behind with no
// tombstone, read receipts could never resolve them, and file access checks
// looked up a chat that did not exist. This moves each such row to
// (chat_id = the thread's chat, thread_id = the old chat_id value).
//
// Both statements are idempotent and self-limiting: after the first pass
// chat_id names a real chat, and a chat id is never also a thread id.
//
// deleted_messages needs no matching migration: the old delete path could not
// write a tombstone for a thread message at all. The client addressed the
// thread by its id, and requireChatMember resolves a chat by id, so the
// request failed with 404 before any row was written. A thread message deleted
// together with its chat got no tombstone either, because the chat deletion
// only selected rows whose chat_id matched the chat. So no tombstone ever
// carries a thread id, and there is nothing to rewrite. Thread tombstones
// written from now on name the real chat, so the delta does deliver them; the
// remaining gap is client-side routing into the thread store, which is why
// store.MessagesChangedSince still excludes thread messages.
//
// Cost of the two statements below: unlike repairFrozenUpdatedAt and the
// normalize pass, they are index-driven rather than scans. SQLite drives them
// from the small side (threads and chats) and probes messages through
// idx_messages_chat_updated and idx_messages_thread_created.
//
// That is the exception, not the rule. InitDB performs about thirteen full
// scans per boot: one per column in utcTimestampColumns (three of them on
// messages) plus repairFrozenUpdatedAt. The normalize probe filters on
// substr(col, -6) <> '+00:00', a function of the column, so no index can serve
// it and SQLite reads the table through whichever covering index it prefers;
// switching the probe to EXISTS does not change that (measured 23ms against
// 26ms for count(*)). Each scan only walks a narrow text column, which is why
// the total stays cheap: roughly 0.3s on 200k messages. Note that the scan
// count is the number of columns in utcTimestampColumns, so adding one there
// adds a scan on every boot.
func backfillMessageThreadID(db *gorm.DB) error {
	// AutoMigrate adds thread_id as NULL for existing rows. Normalise first so
	// every comparison below can rely on the empty string, and so the column
	// needs no default (a `default:` tag would be resolved by GORM into a
	// frozen literal on every insert, see model.Message).
	if err := db.Exec("UPDATE messages SET thread_id = '' WHERE thread_id IS NULL").Error; err != nil {
		return err
	}

	// SQLite evaluates every SET expression against the original row, so
	// thread_id captures chat_id before chat_id is rewritten.
	if err := db.Exec(`UPDATE messages
		SET thread_id = chat_id,
		    chat_id = (SELECT t.chat_id FROM threads t WHERE t.id = messages.chat_id)
		WHERE chat_id IN (SELECT id FROM threads)`).Error; err != nil {
		return err
	}

	// Rows whose thread was already deleted (a chat deletion used to remove
	// threads but leave their messages) point at neither a chat nor a live
	// thread. Mark them as thread rows so they stop masquerading as chat
	// messages and stay out of the chat feed and delta.
	return db.Exec(`UPDATE messages
		SET thread_id = chat_id
		WHERE thread_id = '' AND chat_id NOT IN (SELECT id FROM chats)`).Error
}

// repairFrozenUpdatedAt fixes messages poisoned by the `default:0` tag that
// model.Message used to carry on CreatedAt/UpdatedAt. GORM resolved that tag
// to a concrete instant while parsing the schema and then wrote it into every
// insert that omitted the fields — the whole inbound federation path, which
// builds the message itself. Those rows then failed the `updated_at >= since`
// filter of every sync delta and were never delivered to a catch-up client.
//
// The comparison runs over unixepoch, not over the stored text: timestamps
// carry numeric offsets, so a lexicographic `<` compares wall-clock digits
// instead of instants (an edit at 09:31-04:00 after a creation at 13:30+00:00
// reads as "09:31" < "13:30" and would be clobbered). InitDB normalizes to
// UTC first; the epoch comparison keeps the repair correct even if it ever
// runs before normalization.
func repairFrozenUpdatedAt(db *gorm.DB) error {
	return db.Exec("UPDATE messages SET updated_at = created_at WHERE unixepoch(updated_at) < unixepoch(created_at)").Error
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
	"users":                 {fieldTokenExpireAt, fieldKeyBackupAt},
	// The outbox filters by next_attempt_at and orders by created_at, so
	// both columns are compared in SQL like the ones above. The cursor of
	// the catch-up is only compared in Go and stays out of the list.
	"federation_ops": {fieldCreatedAt, "next_attempt_at"},
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
// normalizeBatchSize bounds one normalize write transaction. Each chunk runs
// in its own transaction so a large legacy database does not hold the write
// lock for the whole table or accumulate every rewrite in memory.
const normalizeBatchSize = 500

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

	var lastRowID int64

	for {
		rows, err := db.Raw(
			"SELECT rowid, "+qual+" FROM "+table+" WHERE "+convertible+" AND rowid > ? ORDER BY rowid LIMIT ?",
			lastRowID, normalizeBatchSize,
		).Rows()
		if err != nil {
			return err
		}

		batch := make([]rewrite, 0, normalizeBatchSize)
		chunkLast := lastRowID

		for rows.Next() {
			var rw rewrite

			if err := rows.Scan(&rw.rowID, &rw.when); err != nil {
				if cerr := rows.Close(); cerr != nil {
					return cerr
				}
				return err
			}

			chunkLast = rw.rowID

			if rw.when.IsZero() {
				continue
			}

			batch = append(batch, rewrite{rowID: rw.rowID, when: rw.when.UTC()})
		}

		if rowsErr := rows.Err(); rowsErr != nil {
			if cerr := rows.Close(); cerr != nil {
				return cerr
			}
			return rowsErr
		}

		if err := rows.Close(); err != nil {
			return err
		}

		if len(batch) > 0 {
			if err := db.Transaction(func(tx *gorm.DB) error {
				for _, rw := range batch {
					if err := tx.Exec("UPDATE "+table+" SET "+column+" = ? WHERE rowid = ?", rw.when, rw.rowID).Error; err != nil {
						return err
					}
				}

				return nil
			}); err != nil {
				return err
			}
		}

		if chunkLast == lastRowID {
			return nil
		}

		lastRowID = chunkLast
	}
}
