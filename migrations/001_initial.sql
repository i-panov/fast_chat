-- Migration: 001_initial
-- Created: 2024-XX-XX

-- Users table
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    public_key TEXT,                          -- E2E encryption public key
    is_admin BOOLEAN DEFAULT FALSE,
    totp_secret VARCHAR(255),                -- encrypted TOTP secret
    totp_enabled BOOLEAN DEFAULT FALSE,
    backup_codes_hash VARCHAR(255),           -- hashed backup codes
    require_2fa BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User sessions for token tracking
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    device_info VARCHAR(255),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for session lookups
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

-- Chats table
CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_group BOOLEAN DEFAULT FALSE,
    name VARCHAR(100),                        -- only for group chats
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for chat queries
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC);

-- Chat participants
CREATE TABLE IF NOT EXISTS chat_participants (
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

-- Index for participant lookups
CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    encrypted_content TEXT NOT NULL,           -- E2E encrypted content
    content_type VARCHAR(20) DEFAULT 'text',   -- text, file, image, audio, video
    file_metadata_id UUID,                     -- references files.id if content_type = file/image/audio/video
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'sent',         -- sent, delivered, read
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for message queries
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

-- Files metadata
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(255) NOT NULL,
    stored_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT NOT NULL,
    uploader_id UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for file queries
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);

-- Active calls (for signaling state)
CREATE TABLE IF NOT EXISTS active_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id),         -- NULL for 1:1 calls
    caller_id UUID REFERENCES users(id),
    callee_id UUID REFERENCES users(id),        -- NULL for group calls
    status VARCHAR(20) DEFAULT 'active',        -- active, ended, declined
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

-- Indexes for call queries
CREATE INDEX IF NOT EXISTS idx_active_calls_caller ON active_calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_active_calls_callee ON active_calls(callee_id);
CREATE INDEX IF NOT EXISTS idx_active_calls_chat ON active_calls(chat_id);
