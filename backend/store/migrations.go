package store

import (
	"gorm.io/gorm"
)

// createIndexes adds the secondary indexes that the hot read paths rely
// on. AutoMigrate only creates the primary key index, so without these
// every chat lookup, message fetch, and file-dedup query does a full
// table scan.
//
// CREATE INDEX IF NOT EXISTS is idempotent on SQLite, so this is safe
// to call on every boot.
func createIndexes(db *gorm.DB) error {
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
	}

	for _, stmt := range statements {
		if err := db.Exec(stmt).Error; err != nil {
			return err
		}
	}

	return nil
}
