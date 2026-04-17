-- Migration: Add E2E key sync tables
-- Adds support for syncing encrypted private keys between devices

-- Add encrypted_private_key column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS encrypted_private_key BYTEA;

-- Table for key sync requests (device confirmation flow)
CREATE TABLE IF NOT EXISTS key_sync_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name VARCHAR(100),
    code VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '10 minutes'
);

-- Index for efficient lookup by user_id
CREATE INDEX IF NOT EXISTS idx_key_sync_requests_user_id ON key_sync_requests(user_id);

-- Index for efficient lookup by code
CREATE INDEX IF NOT EXISTS idx_key_sync_requests_code ON key_sync_requests(code);