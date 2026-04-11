-- Passwordless authentication via email codes
-- Add email column if missing, make password_hash nullable

ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT '';
UPDATE users SET email = username || '@localhost' WHERE email = '' OR email IS NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT NULL;

-- Table for one-time email verification codes
CREATE TABLE IF NOT EXISTS email_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    UNIQUE(email)
);

CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email);
CREATE INDEX IF NOT EXISTS idx_email_codes_expires ON email_codes(expires_at);
