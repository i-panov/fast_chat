-- Passwordless authentication via email codes
-- Remove password_hash, add email verification

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- Table for one-time email verification codes
CREATE TABLE email_codes (
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
