-- Server settings stored in DB (override env defaults)
CREATE TABLE IF NOT EXISTS server_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
