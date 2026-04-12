-- Hidden chats: when a user "deletes" a chat locally,
-- it's hidden from their view but remains visible to other participants.
-- If the chat is recreated with the same participants, the user sees an empty chat.

CREATE TABLE IF NOT EXISTS hidden_chats (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL,  -- not FK: chat may be deleted server-side
    hidden_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_chats_user ON hidden_chats(user_id);
