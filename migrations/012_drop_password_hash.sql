-- Migration 011: Drop deprecated columns from users table
-- Passwordless auth has been the only method since migration 006
-- backup_codes_hash is replaced by backup_codes_encrypted
-- require_2fa is now server-level setting only (server_settings table)

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE users DROP COLUMN IF EXISTS backup_codes_hash;
ALTER TABLE users DROP COLUMN IF EXISTS require_2fa;
