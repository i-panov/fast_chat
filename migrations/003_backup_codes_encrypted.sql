-- Migration: 003_backup_codes_encrypted
-- Add column for AES-GCM encrypted backup codes (so they can be retrieved)

ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes_encrypted TEXT;
