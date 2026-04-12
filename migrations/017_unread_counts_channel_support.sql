-- Migration: 017_unread_counts_channel_support
-- Update unread_counts to support channels in addition to chats.
-- Makes chat_id nullable, adds channel_id with check and composite PK.

-- First, temporarily drop the PK index
ALTER TABLE unread_counts DROP CONSTRAINT IF EXISTS unread_counts_pkey;

-- Add channel_id column
ALTER TABLE unread_counts
    ADD COLUMN channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

-- Make chat_id nullable
ALTER TABLE unread_counts
    ALTER COLUMN chat_id DROP NOT NULL,
    ALTER COLUMN chat_id DROP DEFAULT;

-- Add check constraint: exactly one of chat_id or channel_id must be non-null
ALTER TABLE unread_counts
    ADD CONSTRAINT unread_counts_exclusive
    CHECK ((chat_id IS NOT NULL AND channel_id IS NULL) OR (chat_id IS NULL AND channel_id IS NOT NULL));

-- Recreate primary key with composite
ALTER TABLE unread_counts
    ADD PRIMARY KEY (user_id, COALESCE(chat_id, channel_id));

-- Index for channels
CREATE INDEX IF NOT EXISTS idx_unread_counts_channel ON unread_counts(channel_id) WHERE channel_id IS NOT NULL;

-- Note: Existing idx_unread_counts_user still works for chats, can be extended if needed
