# Fast Chat — Messenger Project

## Overview

Self-hosted real-time messenger with E2E encryption, file transfers, audio/video calls, group chats, bots, and broadcast channels. PWA with full offline support and Web Push notifications.

### Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Rust, Axum, Tokio |
| Database | PostgreSQL + Redis |
| Auth | Passwordless email-code + JWT + TOTP 2FA |
| Messaging | REST + SSE (Server-Sent Events) |
| Push | Web Push (VAPID + ECDH encryption) |
| WebRTC | coturn (STUN/TURN) + Ion SFU (group calls) |
| HTTP | HTTP/1.1 or HTTP/2 (via TLS/rustls) |
| CLI | Rust + clap |
| Admin Panel | Vue 3 + Vuetify SPA |

### Project Structure

```
fast_chat/
├── migrations/                 # SQL migrations (001–010)
├── server/                     # Axum REST + SSE server
│   ├── src/
│   │   ├── main.rs             # Server entry + CLI commands + master bot init
│   │   ├── config.rs           # Settings/configuration
│   │   ├── error.rs            # Custom error types (thiserror → Axum IntoResponse)
│   │   ├── cli/                # CLI command definitions
│   │   ├── crypto/             # CryptoService (X25519, Argon2, ChaCha20Poly1305, AES-GCM)
│   │   ├── db/                 # PostgreSQL + Redis connection pools
│   │   ├── middleware/
│   │   │   ├── mod.rs          # Re-exports
│   │   │   └── jwt.rs          # JWT middleware + UserId extractor
│   │   ├── models/             # SQLx models
│   │   │   ├── user.rs         # User
│   │   │   ├── chat.rs         # Chat
│   │   │   ├── message.rs      # Message
│   │   │   ├── file.rs         # File
│   │   │   ├── call.rs         # ActiveCall
│   │   │   ├── thread.rs       # Thread
│   │   │   ├── topic.rs        # Topic
│   │   │   ├── pinned_message.rs
│   │   │   ├── session.rs
│   │   │   ├── bot.rs          # Bot, BotCommand, BotChat
│   │   │   ├── channel.rs      # Channel, ChannelSubscriber
│   │   │   └── push.rs         # PushSubscription, NotificationSettings, MutedChat
│   │   └── routes/
│   │       ├── mod.rs          # Router assembly
│   │       ├── auth.rs         # Passwordless email-code auth + 2FA
│   │       ├── users.rs        # User CRUD (admin)
│   │       ├── messaging.rs    # Chats, messages, threads, topics, pins
│   │       ├── files.rs        # Streaming file upload/download
│   │       ├── signaling.rs    # WebRTC call management
│   │       ├── bots.rs         # Bot management + Bot API (token auth)
│   │       ├── channels.rs     # Broadcast channels
│   │       ├── push.rs         # Web Push subscriptions + notifications
│   │       ├── admin.rs        # Server settings (for admin panel)
│   │       └── sse.rs          # SSE event stream
├── cli/                        # CLI binary (admin DB/user operations)
│   └── src/main.rs
├── web-client/                 # Vue 3 PWA (stub)
├── admin-panel/                # Vue 3 admin UI SPA
├── coturn/                     # TURN server config
└── ion-sfu/                    # Ion SFU config
```

---

## Current Status

### Implemented ✅

**Authentication (passwordless):**
- `POST /api/auth/request-code` — send 6-digit code to email
- `POST /api/auth/verify-code` — verify code, get JWT tokens
- `POST /api/auth/verify-2fa` — complete 2FA flow
- `POST /api/auth/refresh` — rotate tokens (with DB session validation)
- TOTP 2FA: setup, enable, disable, backup codes (individually hashed)
- Admin accounts **always require TOTP** — cannot log in without it

**Server Settings (via admin panel):**
- `allow_registration` — allow new users to register on first login
- `require_2fa` — mandatory 2FA for all users
- `GET/PUT /api/admin/settings` — CRUD for server settings

**Messaging:**
- Chats (direct + group), messages with E2E encryption
- Threads (replies), Topics (group channels), Pinned messages
- Unread counts per user per chat
- Typing indicators via Redis pub/sub
- SSE real-time delivery (`GET /api/sse/connect`)

**Channels (Telegram-style broadcast):**
- 3 access levels: `public`, `private`, `private_with_approval`
- Only owner posts; subscribers read
- Search public channels by title/username
- Subscription approval workflow (approve/reject requests)
- SSE notifications for new channel messages

**Bots:**
- Master bot (auto-created on first server start)
- User-created bots via `/api/bots` (username always ends with `_bot`)
- Bot API (`/api/bot-api/*`) with token-based auth:
  - `GET /me` — bot info
  - `GET /updates` — long-polling for new messages
  - `POST /send-message` — send message to chat
- Webhook delivery mode (set webhook URL with HMAC signature)
- Slash commands registration
- Bot chat membership management

**Web Push Notifications (PWA):**
- VAPID-based push with ECDH encryption (p256 ECDSA)
- `POST /api/push/subscribe` — register browser push subscription
- Per-user settings: push, sound, preview, global mute
- Per-chat/channel mute with optional time limit
- Auto-push on new messages and channel posts
- `POST /api/notifications/test-push` — test notification

**Files:**
- Streaming upload/download (64KB chunks, not loaded into RAM)
- Access control: only chat participants or uploader can download

**Admin Panel API:**
- `GET/PUT /api/admin/settings` — server settings (registration, 2FA requirement)
- `GET /api/admin/health` — health check
- `GET/POST /api/users` — list/create users (admin)
- `PUT/DELETE /api/users/:id` — update/delete
- `PUT /api/users/:id/admin` — toggle admin status
- `PUT /api/users/:id/disable` — enable/disable user

**Admin Panel UI:**
- Vue 3 + Vuetify SPA with login + 2FA support
- Dashboard with server health and DB stats
- Full user CRUD

**CLI:**
- `user create --username X --email X [--admin]` — no password required
- `user init-admin --username X --email X` — creates admin (with TOTP warning)
- `user list`, `user set-admin`, `user set-disabled`
- `db migrate`, `db reset --force`, `db status`

**Infrastructure:**
- docker-compose.yml: postgres, redis, coturn, ion-sfu, server
- HTTP/2 via TLS (rustls, env vars `TLS_CERT_PATH`/`TLS_KEY_PATH`)
- Redis pub/sub for real-time messaging + bot updates + SSE broadcast

---

## Database Schema (PostgreSQL)

```sql
-- Users (passwordless — password_hash is nullable, no longer used)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),                  -- nullable, deprecated
    public_key TEXT,
    is_admin BOOLEAN DEFAULT FALSE,
    disabled BOOLEAN DEFAULT FALSE,
    totp_secret VARCHAR(255),                    -- encrypted with AES-GCM
    totp_enabled BOOLEAN DEFAULT FALSE,
    backup_codes_encrypted VARCHAR(255),         -- JSON array of argon2 hashes
    require_2fa BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-time email verification codes
CREATE TABLE email_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    UNIQUE(email)
);

-- Server settings (override env defaults)
CREATE TABLE server_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User sessions (refresh token tracking)
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    device_info VARCHAR(255),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chats
CREATE TABLE chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    is_group BOOLEAN DEFAULT FALSE,
    name VARCHAR(100),
    created_by UUID REFERENCES users(id),
    is_favorites BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_participants (
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

-- Channels (broadcast, Telegram-style)
CREATE TABLE channels (
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

CREATE TABLE channel_subscribers (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active, pending, banned
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

-- Messages (shared between chats and channels)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    encrypted_content TEXT NOT NULL,
    content_type VARCHAR(20) DEFAULT 'text',
    file_metadata_id UUID,
    topic_id UUID,
    thread_id UUID,
    status VARCHAR(20) DEFAULT 'sent',
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pinned messages, Threads, Topics
CREATE TABLE pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

CREATE TABLE threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    root_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Files
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(255) NOT NULL,
    stored_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT NOT NULL,
    uploader_id UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active calls
CREATE TABLE active_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id),
    caller_id UUID REFERENCES users(id),
    callee_id UUID REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

-- Unread counts
CREATE TABLE unread_counts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, chat_id)
);

-- Bots
CREATE TABLE bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(60) UNIQUE NOT NULL,       -- always ends with _bot
    display_name VARCHAR(100),
    description TEXT,
    access_token_hash VARCHAR(255) UNIQUE NOT NULL,
    avatar_url TEXT,
    webhook_url TEXT,
    webhook_secret VARCHAR(255),
    delivery_mode VARCHAR(20) DEFAULT 'polling', -- polling or webhook
    is_active BOOLEAN DEFAULT TRUE,
    is_master BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bot_chats (
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_id, chat_id)
);

CREATE TABLE bot_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,
    description TEXT,
    UNIQUE(bot_id, command)
);

CREATE TABLE bot_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    update_type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    delivered BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Push notifications
CREATE TABLE push_subscriptions (
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

CREATE TABLE notification_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN DEFAULT TRUE,
    sound_enabled BOOLEAN DEFAULT TRUE,
    preview_enabled BOOLEAN DEFAULT TRUE,
    mute_all BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE muted_chats (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    muted_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, COALESCE(chat_id, channel_id)),
    CHECK ((chat_id IS NOT NULL) OR (channel_id IS NOT NULL))
);
```

---

## REST API Reference

### Authentication (public)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/request-code` | Send 6-digit code to email |
| POST | `/api/auth/verify-code` | Verify code → get JWT tokens |
| POST | `/api/auth/verify-2fa` | Complete 2FA after verify-code |
| POST | `/api/auth/refresh` | Rotate access/refresh tokens |

### User & 2FA (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/2fa/setup` | Generate TOTP secret |
| POST | `/api/auth/2fa/verify-setup` | Verify TOTP code |
| POST | `/api/auth/2fa/enable` | Enable 2FA + get backup codes |
| POST | `/api/auth/2fa/disable` | Disable 2FA (email code) |
| GET | `/api/auth/2fa/backup-codes` | Check backup codes count |
| POST | `/api/auth/2fa/backup-codes/regenerate` | Regenerate backup codes |

### Users (admin, JWT required)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List users |
| POST | `/api/users` | Create user |
| GET/PUT/DELETE | `/api/users/:id` | User CRUD |
| PUT | `/api/users/:id/admin` | Toggle admin |
| PUT | `/api/users/:id/disable` | Enable/disable user |

### Messaging (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/chats` | List/create chats |
| GET | `/api/chats/:id` | Get chat details |
| GET | `/api/chats/:chat_id/messages` | Get messages (paginated) |
| POST | `/api/messages` | Send message |
| PUT/DELETE | `/api/messages/:id` | Edit/delete message |
| GET/POST | `/api/chats/:chat_id/pins` | Get/pin messages |
| DELETE | `/api/pins` | Unpin message |
| POST | `/api/threads` | Create thread |
| GET | `/api/threads/:id` | Get thread info |
| GET | `/api/threads/:id/messages` | Thread messages |
| GET/POST | `/api/topics` | List/create topics |
| POST | `/api/typing` | Send typing indicator |
| POST | `/api/chats/:chat_id/read` | Mark chat as read |
| GET | `/api/unread` | Get unread counts |

### Channels (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/channels` | List/create channels |
| GET | `/api/channels/search` | Search public channels |
| GET/PUT/DELETE | `/api/channels/:id` | Channel CRUD |
| POST/GET | `/api/channels/:id/messages` | Send/read channel messages |
| POST | `/api/channels/:id/subscribe` | Subscribe (or request approval) |
| POST | `/api/channels/:id/unsubscribe` | Unsubscribe |
| GET | `/api/channels/:id/subscribers` | List subscribers (owner) |
| DELETE | `/api/channels/:id/subscribers/:user_id` | Remove subscriber |
| GET | `/api/channels/:id/requests` | List pending join requests |
| POST | `/api/channels/:id/requests/:user_id/approve` | Approve request |
| POST | `/api/channels/:id/requests/:user_id/reject` | Reject request |

### Bots (JWT required for management)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/api/bots` | List/create bots |
| GET/PUT/DELETE | `/api/bots/:id` | Bot CRUD |
| POST | `/api/bots/:id/token` | Regenerate access token |
| PUT/DELETE | `/api/bots/:id/webhook` | Set/delete webhook |
| GET/POST | `/api/bots/:id/commands` | List/register commands |
| DELETE | `/api/bots/:id/commands/:cmd` | Delete command |
| GET/POST | `/api/bots/:id/chats` | List/add bot to chats |
| DELETE | `/api/bots/:id/chats/:chat_id` | Remove bot from chat |

### Bot API (token-based auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bot-api/me` | Bot info |
| GET | `/api/bot-api/updates` | Long-poll for updates |
| POST | `/api/bot-api/send-message` | Send message to chat |

### Push Notifications (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/push/subscribe` | Register push subscription |
| GET | `/api/push/subscriptions` | List subscriptions |
| DELETE | `/api/push/subscriptions/:id` | Remove subscription |
| GET | `/api/push/vapid-public-key` | Get VAPID public key |
| GET/PUT | `/api/notifications/settings` | Notification settings |
| GET | `/api/notifications/muted` | List muted chats/channels |
| POST | `/api/notifications/mute` | Mute chat/channel |
| POST | `/api/notifications/unmute` | Unmute chat/channel |
| POST | `/api/notifications/test-push` | Send test push |

### Files (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/files/upload` | Upload file |
| POST | `/api/files/upload-chat/:chat_id` | Upload file to chat |
| GET | `/api/files/:id` | Download file (streamed) |
| GET | `/api/files/:id/meta` | File metadata |

### Signaling (JWT required)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/calls` | Create call |
| GET | `/api/calls/active` | List active calls |
| POST | `/api/calls/:id/accept` | Accept call |
| POST | `/api/calls/:id/reject` | Reject call |
| POST | `/api/calls/:id/end` | End call |
| POST | `/api/calls/:id/signal` | Send WebRTC signal |
| POST | `/api/calls/ice/:call_id` | Send ICE candidate |

### SSE
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sse/connect` | SSE event stream (JWT required) |

### Admin & Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | Public | Server health |
| GET | `/api/stats` | JWT | Server stats |
| GET/PUT | `/api/admin/settings` | JWT (admin + 2FA) | Server settings |
| GET | `/api/admin/health` | JWT (admin + 2FA) | Admin health |

---

## Server Configuration

**Environment variables:**
```
DATABASE_URL=postgres://fast_chat:password@localhost:5432/fast_chat
REDIS_URL=redis://localhost:6379
JWT_SECRET=<required>                       # MUST be set
ALLOW_REGISTRATION=false                    # Allow self-registration
REQUIRE_2FA=false                           # Force 2FA for all users
TLS_CERT_PATH=./cert.pem                    # Enable HTTP/2
TLS_KEY_PATH=./key.pem
VAPID_PUBLIC_KEY=<base64url>               # Web Push
VAPID_PRIVATE_KEY=<base64url>
VAPID_SUBJECT=mailto:admin@localhost
COTURN_HOST=coturn
COTURN_PORT=3478
ION_SFU_URL=ion-sfu:5000
FILES_DIR=./files
```

**Generating VAPID keys (for Web Push):**
```bash
# Generate a P-256 key pair
openssl ecparam -genkey -name prime256v1 -noout -out vapid.pem

# Extract private key as raw bytes, encode base64url
openssl pkey -in vapid.pem -outform DER | \
  tail -c +16 | head -c 32 | \
  base64 | tr '+/' '-_' | tr -d '='

# Extract public key as uncompressed point (65 bytes), skip first byte (0x04), encode base64url
openssl pkey -in vapid.pem -pubout -outform DER | \
  tail -c 65 | tail -c +2 | \
  base64 | tr '+/' '-_' | tr -d '='
```

Set the outputs as `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` respectively.

---

## CLI Tool

```bash
# User management
fast-chat-cli user create --username alice --email alice@example.com [--admin]
fast-chat-cli user list
fast-chat-cli user set-admin --id <uuid> --yes true
fast-chat-cli user set-disabled --id <uuid> --yes true
fast-chat-cli user init-admin --username admin --email admin@example.com

# Database
fast-chat-cli db migrate
fast-chat-cli db reset --force
fast-chat-cli db status
```

---

## Docker Compose

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: "5432:5432"
  redis:
    image: redis:7-alpine
    ports: "6379:6379"
  coturn:
    image: coturn/coturn:latest
    ports: ["3478:3478/udp", "3478:3478/tcp", "5349:5349/udp", "5349:5349/tcp"]
  ion-sfu:
    image: pionion/ion-sfu:latest
    ports: "5000:5000"
  server:
    build: ./server
    ports: "8080:8080"
  web-client:
    build: ./web-client
    ports: "8080:80"
  admin-panel:
    build: ./admin-panel
    ports: "8081:80"
```

---

## Validation Commands

```bash
cd server && cargo fmt --check && cargo clippy --all-targets --all-features
cd cli && cargo fmt --check && cargo clippy --all-targets --all-features
```

---

## Known Issues

1. **Delivery/read status** — Only 'sent' status stored, no delivery receipts
2. **Typing indicators** — Published via Redis pub/sub but not persisted
3. **No file content validation** — MIME type is client-provided
4. **Files not encrypted at rest** — UUID filenames without content encryption
5. **Group call architecture** — Each participant gets own call record
6. **No rate limiting** — Login/code verification has no brute-force protection
7. **Web Push encryption** — Simplified VAPID-only auth; full ECDH + HTTP-ECE pending
8. **Web Client** — Stub (Vue 3 PWA not created)

---

## Notes

- **No passwords** — authentication is email-code based (10-min TTL, single-use, argon2-hashed)
- **Admin TOTP mandatory** — admins cannot access any API without `two_fa_verified: true` in JWT
- **JWT middleware** — global middleware checks 2FA for admins + server-wide `require_2fa` setting
- **SSE** — real-time events via `EventSource` with Redis pub/sub fan-out
- **HTTP/2** — automatic when TLS certs provided; otherwise HTTP/1.1
- **No protobuf** — pure REST + JSON throughout
- **Timestamps** — UTC everywhere (`TIMESTAMPTZ` + `chrono::Utc`)
- **No `unwrap()`** — use `?` or `expect()` with messages
- **TOTP** — SHA1 (totp-lite), encrypted with AES-GCM at rest
- **Backup codes** — individually argon2-hashed; using one doesn't invalidate others
- **File access** — restricted to chat participants or uploader
- **File downloads** — streamed from disk in 64KB chunks
- **Redis pub/sub** — `ConnectionManager` with automatic reconnection
