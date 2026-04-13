-- Consolidated initial migration — all schema definitions
-- Replaces migrations 001–017

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Schema tracking ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(20) PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Users (passwordless: no password_hash) ──────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    public_key TEXT,
    is_admin BOOLEAN DEFAULT FALSE,
    disabled BOOLEAN DEFAULT FALSE,
    totp_secret VARCHAR(255),
    totp_enabled BOOLEAN DEFAULT FALSE,
    backup_codes_encrypted TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Email verification codes ────────────────────────────────
CREATE TABLE IF NOT EXISTS email_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    UNIQUE(email)
);
CREATE INDEX idx_email_codes_email ON email_codes(email);
CREATE INDEX idx_email_codes_expires ON email_codes(expires_at);

-- ── User sessions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    device_info VARCHAR(255),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX idx_user_sessions_token ON user_sessions(refresh_token_hash);
CREATE INDEX idx_user_sessions_user_expires ON user_sessions(user_id, expires_at);

-- ── Server settings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Channels (broadcast) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    username VARCHAR(50) UNIQUE,
    access_level VARCHAR(20) NOT NULL DEFAULT 'private',
    avatar_url TEXT,
    subscribers_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_channels_owner ON channels(owner_id);
CREATE INDEX idx_channels_access ON channels(access_level);
CREATE INDEX idx_channels_username ON channels(username);

-- ── Channel subscribers ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS channel_subscribers (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_channel_subscribers_status ON channel_subscribers(channel_id, status);
CREATE INDEX idx_channel_subscribers_user ON channel_subscribers(user_id);

-- ── Chats ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_group BOOLEAN DEFAULT FALSE,
    name VARCHAR(100),
    created_by UUID REFERENCES users(id),
    is_favorites BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_chats_created_at ON chats(created_at DESC);

-- ── Chat participants ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_chat_participants_user_id ON chat_participants(user_id);

-- ── Hidden chats ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hidden_chats (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL,
    hidden_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX idx_hidden_chats_user ON hidden_chats(user_id);

-- ── Threads (FK to messages added later) ───────────────────
CREATE TABLE IF NOT EXISTS threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    root_message_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_threads_chat ON threads(chat_id);
CREATE INDEX idx_threads_root ON threads(root_message_id);

-- ── Topics ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_topics_chat ON topics(chat_id);

-- ── Messages (chat OR channel) ─────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    encrypted_content TEXT NOT NULL,
    content_type VARCHAR(20) DEFAULT 'text',
    file_metadata_id UUID,
    topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
    thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'sent',
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_topic ON messages(topic_id);
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_channel_id ON messages(channel_id) WHERE channel_id IS NOT NULL;

-- ── Threads FK (deferred to avoid circular dependency) ─────
ALTER TABLE threads ADD CONSTRAINT threads_root_message_id_fkey
    FOREIGN KEY (root_message_id) REFERENCES messages(id) ON DELETE CASCADE;

-- ── Pinned messages ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);
CREATE INDEX idx_pinned_chat ON pinned_messages(chat_id);
CREATE INDEX idx_pinned_user ON pinned_messages(user_id);

-- ── Files ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(255) NOT NULL,
    stored_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT NOT NULL,
    uploader_id UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_files_uploader ON files(uploader_id);

-- ── Active calls ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS active_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id),
    caller_id UUID REFERENCES users(id),
    callee_id UUID REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);
CREATE INDEX idx_active_calls_caller ON active_calls(caller_id);
CREATE INDEX idx_active_calls_callee ON active_calls(callee_id);
CREATE INDEX idx_active_calls_chat ON active_calls(chat_id);

-- ── Unread counts (chat OR channel) ────────────────────────
CREATE TABLE IF NOT EXISTS unread_counts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ
);
ALTER TABLE unread_counts ADD CONSTRAINT unread_counts_exclusive
    CHECK ((chat_id IS NOT NULL AND channel_id IS NULL) OR (chat_id IS NULL AND channel_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS unread_counts_pk ON unread_counts(user_id, COALESCE(chat_id, channel_id));
CREATE INDEX idx_unread_counts_user ON unread_counts(user_id, count DESC);
CREATE INDEX idx_unread_counts_channel ON unread_counts(channel_id) WHERE channel_id IS NOT NULL;

-- ── Push notifications ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth_secret TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, endpoint)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ── Notification settings ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN DEFAULT TRUE,
    sound_enabled BOOLEAN DEFAULT TRUE,
    preview_enabled BOOLEAN DEFAULT TRUE,
    mute_all BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Muted chats/channels ────────────────────────────────────
CREATE TABLE IF NOT EXISTS muted_chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    muted_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK ((chat_id IS NOT NULL) OR (channel_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_muted_chats_unique ON muted_chats(user_id, COALESCE(chat_id, channel_id));

-- ── Bots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(60) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    description TEXT,
    access_token_hash VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    webhook_url TEXT,
    webhook_secret VARCHAR(255),
    delivery_mode VARCHAR(20) DEFAULT 'polling',
    is_active BOOLEAN DEFAULT TRUE,
    is_master BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bots_owner_id ON bots(owner_id);
CREATE INDEX idx_bots_username ON bots(username);

-- ── Bot chats ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_chats (
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, chat_id)
);

-- ── Bot commands ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,
    description TEXT,
    UNIQUE(bot_id, command)
);
CREATE INDEX idx_bot_commands_bot_id ON bot_commands(bot_id);

-- ── Bot updates ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    update_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    delivered BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bot_updates_bot_id ON bot_updates(bot_id);
CREATE INDEX idx_bot_updates_delivered ON bot_updates(bot_id, delivered);
