-- Migration: 003_unread_counts
-- Track per-user per-chat unread message counts

CREATE TABLE IF NOT EXISTS unread_counts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_unread_counts_chat ON unread_counts(chat_id);
CREATE INDEX IF NOT EXISTS idx_unread_counts_user ON unread_counts(user_id) WHERE count > 0;
