-- Migration: 016_messages_channel_support
-- Allow messages to belong to either a chat OR a channel.
-- Makes chat_id nullable, adds channel_id with FK to channels.

ALTER TABLE messages
    ALTER COLUMN chat_id DROP NOT NULL,
    ALTER COLUMN chat_id DROP DEFAULT;

ALTER TABLE messages
    ADD COLUMN channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

-- Index for channel message queries
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id) WHERE channel_id IS NOT NULL;
