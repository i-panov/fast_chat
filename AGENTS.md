# Fast Chat — Messenger Project

## Overview

Real-time messenger with E2E encryption, file transfers, audio/video calls, and group chats. PWA with full offline support.

### Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Rust, Tonic, Prost, Tokio |
| Database | PostgreSQL + Redis |
| Auth | JWT + TOTP 2FA |
| Messaging | gRPC streaming (tonic + prost) |
| WebRTC | coturn (STUN/TURN) + Ion SFU (group calls) |
| Media Server | coturn + ion-sfu (official Docker images) |
| CLI | Rust + clap |

### Project Structure

```
fast_chat/
├── proto/                      # Protobuf definitions
├── migrations/                 # SQL migrations
├── server/                     # Tonic gRPC server
│   ├── src/
│   │   ├── main.rs             # Server entry + CLI commands
│   │   ├── config.rs
│   │   ├── build.rs            # Proto compilation
│   │   ├── error.rs            # Custom error types
│   │   ├── db/
│   │   │   ├── postgres.rs     # PostgresPool
│   │   │   └── redis.rs        # RedisPool
│   │   ├── models/             # SQLx models (User, Chat, Message, etc.)
│   │   ├── services/           # gRPC service implementations
│   │   ├── crypto/             # CryptoService (X25519, Argon2, ChaCha20Poly1305)
│   │   ├── middleware/         # JWT authentication helpers
│   │   ├── cli/                # CLI command definitions
│   │   └── proto/              # Generated from proto/
├── cli/                        # CLI binary (admin operations)
│   └── src/main.rs
├── web-client/                 # Vue 3 + Vuetify PWA (stub)
├── admin-panel/                # Vue 3 admin UI (SPA with CRUD, dashboard, settings)
├── wasm-sdk/                   # WebAssembly SDK (for web client crypto)
├── ion-sfu/                    # Ion SFU config
├── coturn/                     # coturn config only
└── docker-compose.yml
```

---

## Current Status

### Implemented ✅

**Proto files:**
- `common.proto` - Base messages (User, AuthResponse, Chat, Message, FileMetadata, Ack, etc.)
- `auth.proto` - AuthService (register, login, refresh_token, get_current_user)
- `users.proto` - UsersService (CRUD, 2FA management)
- `messaging.proto` - MessagingService (chats, messages, threads, topics, pinned messages)
- `files.proto` - FilesService (streaming upload/download)
- `signaling.proto` - SignalingService (WebRTC call management)

**Database:**
- `001_initial.sql` - users, user_sessions, chats, chat_participants, messages, files, active_calls
- `002_features.sql` - pinned_messages, threads, topics, favorites, disabled users
- `003_unread_counts.sql` - per-user per-chat unread message counts

**Server services:**
- AuthService - JWT auth with TOTP 2FA and backup codes (encrypted)
- UsersService - User CRUD, 2FA setup/verify/enable/disable (TOTP secrets encrypted at rest)
- MessagingService - Chats, messages, threads, topics, pins, unread counts, typing indicators
- FilesService - Streaming file upload/download with access control (chat participant check)
- SignalingService - 1:1 and group call management

**REST API (admin-only):**
- `GET /api/health` - Server health (public)
- `GET /api/users` - List users (admin, JWT required)
- `POST /api/users` - Create user (admin, JWT required)
- `PUT /api/users/:id` - Update user (admin, JWT required)
- `DELETE /api/users/:id` - Delete user (admin, JWT required)
- `PUT /api/users/:id/admin` - Set admin status (admin, JWT required)
- `PUT /api/users/:id/disable` - Enable/disable user (admin, JWT required)
- `GET /api/stats` - Server stats (admin, JWT required)

**Admin Panel:**
- Vue 3 + Vuetify SPA (fully implemented)
- Login with 2FA support
- Dashboard with server health and database stats
- Full user CRUD (create, edit, delete, enable/disable, admin toggle)
- Settings with server info and configuration

**CLI:**
- User management (create, list, set-admin, set-disabled)
- Database operations (migrate, reset, status)

**Infrastructure:**
- docker-compose.yml with postgres, redis, coturn, ion-sfu, server

### Not Implemented / Issues ⚠️

| Feature | Status | Notes |
|---------|--------|-------|
| Web Client | Stub | Vue 3 + Vuetify PWA not created |
| Admin Panel | ✅ Done | Full Vue 3 SPA with CRUD, dashboard, settings |
| Admin gRPC service | Removed | Admin functions moved to REST API — `admin.proto` deleted |
| JWT secret | 🔒 Required | Server refuses to start without `JWT_SECRET` env var |
| TOTP encryption | ✅ Done | TOTP secrets encrypted with AES-GCM at rest |
| Backup codes | ✅ Done | Each code individually hashed — using one doesn't invalidate others |
| File access control | ✅ Done | Only chat participants or uploader can download |
| File streaming | ✅ Done | Files streamed from disk in 64KB chunks (not loaded into RAM) |
| Unread counts | ✅ Done | `unread_counts` table created in migration 003 |
| Refresh token DB validation | ✅ Done | Validates both JWT signature and DB session |
| ICE candidate relay | ✅ Done | Relayed via Redis pub/sub with auth check |
| Real-time messaging | ✅ Done | Uses Redis pub/sub |
| Delivery/read status | Partial | Only 'sent' status stored, no delivery receipts |
| Typing indicators | Partial | Implemented (publishes via Redis), but no persistence |
| Group call architecture | Limitation | Each participant gets own call record — events on separate channels (see signaling.rs TODO) |

---

## Database Schema (PostgreSQL)

```sql
-- Users (password_hash uses argon2)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    public_key TEXT,                          -- E2E encryption public key
    is_admin BOOLEAN DEFAULT FALSE,
    disabled BOOLEAN DEFAULT FALSE,
    totp_secret VARCHAR(255),                 -- TOTP secret (encrypted with AES-GCM)
    totp_enabled BOOLEAN DEFAULT FALSE,
    backup_codes_hash VARCHAR(255),           -- (deprecated, legacy)
    backup_codes_encrypted VARCHAR(255),      -- JSON array of argon2 hashes (individually hashed)
    require_2fa BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User sessions (for token tracking - not currently used)
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

-- Chat participants
CREATE TABLE chat_participants (
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (chat_id, user_id)
);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id),
    encrypted_content TEXT NOT NULL,
    content_type VARCHAR(20) DEFAULT 'text',
    file_metadata_id UUID,
    topic_id UUID,                            -- FK to topics
    thread_id UUID,                           -- FK to threads
    status VARCHAR(20) DEFAULT 'sent',
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pinned messages
CREATE TABLE pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global pin
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

-- Threads (message replies)
CREATE TABLE threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    root_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Topics (group chat channels)
CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Files metadata
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(255) NOT NULL,
    stored_path VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT NOT NULL,
    uploader_id UUID REFERENCES users(id),
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active calls (WebRTC state)
CREATE TABLE active_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id),        -- NULL for 1:1 calls
    caller_id UUID REFERENCES users(id),
    callee_id UUID REFERENCES users(id),     -- NULL for group calls
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

-- Unread counts (per-user, per-chat)
CREATE TABLE unread_counts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, chat_id)
);
```

---

## Server Configuration

**Environment variables:**
```
DATABASE_URL=postgres://fast_chat:password@localhost:5432/fast_chat
REDIS_URL=redis://localhost:6379
JWT_SECRET=<required>              # MUST be set — server refuses to start without it
COTURN_HOST=coturn
COTURN_PORT=3478
ION_SFU_URL=ion-sfu:5000
FILES_DIR=./files
```

**Build note:** Proto files are located in `../proto/` relative to server, configured in `server/build.rs`:
```rust
let proto_files = &[
    "../proto/common.proto",
    "../proto/auth.proto",
    ...
];
```

---

## CLI Tool

**Build:**
```bash
cd cli && cargo build --release
```

**Usage:**
```bash
# Server binary (includes CLI)
cargo run --release -- [OPTIONS] [COMMAND]

# Or use the separate CLI binary
fast-chat-cli --server http://localhost:50051 <command>

# User management
fast-chat-cli user create --username alice --email alice@example.com --password <pass>
fast-chat-cli user list --page 1 --page-size 50
fast-chat-cli user set-admin --id <uuid> --yes true
fast-chat-cli user set-disabled --id <uuid> --yes true
fast-chat-cli user init-admin --username admin --email admin@example.com --password <pass>

# Database
fast-chat-cli db migrate
fast-chat-cli db reset
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
    ports:
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "5349:5349/udp"
      - "5349:5349/tcp"

  ion-sfu:
    image: pionion/ion-sfu:latest
    ports: "5000:5000"

  server:
    build: ./server
    ports: "50051:50051"

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
# Server
cd server && cargo fmt --check && cargo clippy --all-targets --all-features

# CLI
cd cli && cargo fmt --check && cargo clippy --all-targets --all-features

# Build release binaries
cd server && cargo build --release
cd cli && cargo build --release
```

---

## Known Issues

1. **Delivery/read status** — Only 'sent' status stored, no delivery/read receipts

2. **Typing indicators** — Published via Redis pub/sub but not persisted

3. **No file content validation** — MIME type is client-provided; no magic bytes inspection

4. **Files not encrypted at rest** — Stored with UUID filenames in `files_dir` without content encryption

5. **Group call architecture** — Each participant creates their own `active_calls` record and listens on their own Redis channel. Participants do NOT hear each other's events. A proper fix requires a single chat-level call record with a shared channel, or direct Ion SFU integration.

6. **No rate limiting** — Login, 2FA verification, and call initiation have no brute-force protection

---

## Notes

- All timestamps use UTC (TIMESTAMPTZ in Postgres, chrono::Utc in Rust)
- Error handling: custom error types via thiserror, gRPC Status for transport
- Logging: tracing crate with JSON formatter for production
- No `unwrap()` in production code — use `?` or `expect()` with messages
- Self-hosted: no public registration — all users created by admin via CLI
- E2E encryption: X25519 keypairs generated on registration; however, the server generates and returns private keys, so this is "server-trusted" encryption, not true E2E
- TOTP secrets are encrypted with AES-GCM before storage
- Backup codes are individually hashed with argon2 — using one code does not invalidate others
- `JWT_SECRET` environment variable is **required** — server refuses to start without it
- Admin functions are exposed via REST API (`/api/users/*`, `/api/stats`) with JWT + admin role check
- coturn and ion-sfu use official Docker images
- TOTP uses SHA1 (totp-lite crate) - suitable for basic 2FA
- Redis pub/sub uses `ConnectionManager` with automatic reconnection attempts
- File downloads are streamed from disk in 64KB chunks (not loaded into memory)
- File access is restricted to chat participants or the original uploader

## Prerequisites

```bash
# Install protobuf compiler
# Ubuntu/Debian:
apt-get install protobuf-compiler

# macOS:
brew install protobuf

# Build server
cd server && cargo build --release

# Build CLI
cd cli && cargo build --release
```