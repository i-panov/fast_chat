-- Channels (Telegram-style broadcast channels)

CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    username VARCHAR(50) UNIQUE,             -- unique handle for lookup (e.g. @mychannel)
    access_level VARCHAR(20) NOT NULL DEFAULT 'private', -- public, private, private_with_approval
    avatar_url TEXT,
    subscribers_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_channels_owner ON channels(owner_id);
CREATE INDEX idx_channels_access ON channels(access_level);
CREATE INDEX idx_channels_username ON channels(username);

-- Channel subscribers (with approval support)
CREATE TABLE channel_subscribers (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, pending, banned
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_channel_subscribers_status ON channel_subscribers(channel_id, status);
CREATE INDEX idx_channel_subscribers_user ON channel_subscribers(user_id);
