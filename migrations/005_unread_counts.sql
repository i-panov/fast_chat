-- Migration: 005_unread_counts
-- Track unread message counts per user per chat

CREATE TABLE IF NOT EXISTS unread_counts (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, chat_id)
);

-- Index for fetching unread chats for a user
CREATE INDEX IF NOT EXISTS idx_unread_counts_user ON unread_counts(user_id, count DESC);
