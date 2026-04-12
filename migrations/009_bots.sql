-- Bot system
-- Bots are separate entities from users, owned by users

CREATE TABLE bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    username VARCHAR(60) UNIQUE NOT NULL,       -- always ends with _bot
    display_name VARCHAR(100),
    description TEXT,
    access_token_hash VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    webhook_url TEXT,                           -- if set, server sends updates here
    webhook_secret VARCHAR(255),                -- HMAC secret for webhook verification
    delivery_mode VARCHAR(20) DEFAULT 'polling', -- polling or webhook
    is_active BOOLEAN DEFAULT TRUE,
    is_master BOOLEAN DEFAULT FALSE,            -- the master bot
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bots_owner_id ON bots(owner_id);
CREATE INDEX idx_bots_username ON bots(username);

-- Bot conversations: which chats the bot participates in
CREATE TABLE bot_chats (
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, chat_id)
);

-- Bot commands: registered commands for slash commands
CREATE TABLE bot_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,              -- without leading /
    description TEXT,
    UNIQUE(bot_id, command)
);

CREATE INDEX idx_bot_commands_bot_id ON bot_commands(bot_id);

-- Bot update delivery tracking (for long-polling)
CREATE TABLE bot_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    update_type VARCHAR(30) NOT NULL,           -- message, inline_query, callback_query, etc.
    payload JSONB NOT NULL,
    delivered BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bot_updates_bot_id ON bot_updates(bot_id);
CREATE INDEX idx_bot_updates_delivered ON bot_updates(bot_id, delivered);
