# QWEN.md — Fast Chat Project Context

## Overview

Self-hosted real-time messenger with E2E encryption, file transfers, audio/video calls, group chats, bots, and broadcast channels. PWA with Web Push notifications.

### Architecture

| Layer | Technology |
|-------|------------|
| **Backend** | Rust, Axum, Tokio |
| **Database** | PostgreSQL 16 + Redis 7 |
| **Auth** | Passwordless email-code + JWT + TOTP 2FA |
| **Messaging** | REST + SSE (Server-Sent Events) |
| **Push** | Web Push (VAPID + p256 ECDSA) |
| **WebRTC** | coturn (STUN/TURN) + Ion SFU |
| **HTTP** | HTTP/1.1 or HTTP/2 (TLS via rustls) |
| **CLI** | Rust + clap |
| **Admin Panel** | Vue 3 + Vuetify SPA |

### Directory Structure

```
fast_chat/
├── proto/                      # (DELETED — was protobuf)
├── migrations/                 # SQL migrations (001–010)
├── server/                     # Axum REST + SSE server
│   ├── src/
│   │   ├── main.rs             # Entry + CLI + master bot init
│   │   ├── config.rs           # Settings
│   │   ├── error.rs            # Custom errors (IntoResponse for Axum)
│   │   ├── cli/                # CLI commands
│   │   ├── crypto/             # CryptoService
│   │   ├── db/                 # PostgreSQL + Redis pools
│   │   ├── middleware/
│   │   │   └── jwt.rs          # JWT middleware + UserId extractor
│   │   ├── models/             # SQLx models
│   │   └── routes/             # All route handlers
│   │       ├── auth.rs         # Passwordless auth + 2FA
│   │       ├── users.rs        # User CRUD (admin)
│   │       ├── messaging.rs    # Chats, messages, threads, topics
│   │       ├── files.rs        # File upload/download
│   │       ├── signaling.rs    # WebRTC calls
│   │       ├── bots.rs         # Bot management + Bot API
│   │       ├── channels.rs     # Broadcast channels
│   │       ├── push.rs         # Web Push + notification settings
│   │       ├── admin.rs        # Server settings API
│   │       └── sse.rs          # SSE event stream
├── cli/                        # CLI binary
├── web-client/                 # Vue 3 PWA (stub)
├── admin-panel/                # Vue 3 admin SPA
├── wasm-sdk/                   # (DELETED — was WebAssembly SDK)
├── envoy/                      # (DELETED — was gRPC proxy)
├── coturn/                     # TURN config
└── ion-sfu/                    # SFU config
```

## Building and Running

### Prerequisites

```bash
# Rust toolchain (1.78+)
rustup toolchain install stable
```

### Server

```bash
cd server
cargo build --release
cargo run --release                    # Start on :8080
```

### CLI

```bash
cd cli && cargo build --release

# Commands:
fast-chat-cli user create --username alice --email alice@example.com [--admin]
fast-chat-cli user list
fast-chat-cli user set-admin --id <uuid> --yes true
fast-chat-cli user set-disabled --id <uuid> --yes true
fast-chat-cli user init-admin --username admin --email admin@example.com
fast-chat-cli db migrate
fast-chat-cli db reset --force
fast-chat-cli db status
```

### Docker Compose

```bash
docker-compose up -d
# server: 8080, postgres: 5432, redis: 6379, coturn: 3478, ion-sfu: 5000
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | `postgres://fast_chat:changeme@localhost:5432/fast_chat` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `JWT_SECRET` | JWT signing secret | **Required** — server refuses to start without it |
| `ALLOW_REGISTRATION` | Self-registration on login | `false` |
| `REQUIRE_2FA` | Mandatory 2FA for all users | `false` |
| `TLS_CERT_PATH` | TLS cert for HTTP/2 | — |
| `TLS_KEY_PATH` | TLS key for HTTP/2 | — |
| `VAPID_PUBLIC_KEY` | Web Push public key (base64url) | — |
| `VAPID_PRIVATE_KEY` | Web Push private key (base64url) | — |
| `VAPID_SUBJECT` | VAPID subject | `mailto:admin@localhost` |

**Generating VAPID keys:**
```bash
openssl ecparam -genkey -name prime256v1 -noout -out vapid.pem
# Private key (32 bytes, base64url):
openssl pkey -in vapid.pem -outform DER | tail -c +16 | head -c 32 | base64 | tr '+/' '-_' | tr -d '='
# Public key (64 bytes, base64url):
openssl pkey -in vapid.pem -pubout -outform DER | tail -c 65 | tail -c +2 | base64 | tr '+/' '-_' | tr -d '='
```

### Code Quality

```bash
cd server && cargo fmt --check && cargo clippy --all-targets --all-features
cd cli && cargo fmt --check && cargo clippy --all-targets --all-features
```

## API Overview

### Authentication (passwordless)
1. `POST /api/auth/request-code` → `{email}` → server sends 6-digit code
2. `POST /api/auth/verify-code` → `{email, code, totp_code?}` → JWT tokens
3. If 2FA needed but no TOTP provided → `{need_2fa: true, user_id}` → call `POST /api/auth/verify-2fa`

### JWT Middleware
- Global middleware on all protected routes
- Validates JWT from `Authorization: Bearer <token>`
- Inserts `user_id` into request extensions (`UserId` extractor)
- **Blocks admins without `two_fa_verified`** — returns 412
- **Blocks all users when `require_2fa=true`** without 2FA

### SSE
- `GET /api/sse/connect` — single long-lived stream
- Events: `new_message`, `typing`, `channel_message`, `channel_subscription_approved`, etc.
- Backed by Redis pub/sub

### Bot API
- Management: `/api/bots/*` (JWT auth)
- Runtime: `/api/bot-api/*` (Bearer token auth, no JWT)
- Delivery: long-polling (`/updates`) or webhook (POST to bot's URL with HMAC signature)

## Database Schema

See `AGENTS.md` for full schema. Key tables: `users`, `chats`, `messages`, `channels`, `bots`, `push_subscriptions`, `notification_settings`, `muted_chats`, `email_codes`, `server_settings`, `bot_updates`.

## Migrations

| File | Purpose |
|------|---------|
| `001_initial.sql` | users, sessions, chats, participants, messages, files, calls |
| `002_features.sql` | pinned_messages, threads, topics, favorites, disabled users |
| `003_unread_counts.sql` | per-user per-chat unread counts |
| `006_passwordless_auth.sql` | nullable password_hash, email_codes table |
| `007_server_settings.sql` | server_settings table (allow_registration, require_2fa) |
| `008_bots.sql` | bots, bot_chats, bot_commands, bot_updates |
| `009_channels.sql` | channels, channel_subscribers |
| `010_push_notifications.sql` | push_subscriptions, notification_settings, muted_chats |

## Current Status

### Implemented ✅
- Passwordless email-code auth with TOTP 2FA
- JWT middleware with admin 2FA enforcement
- Server settings API (registration, mandatory 2FA)
- Messaging: chats, messages, threads, topics, pins, unread counts
- Channels: public/private/approval, owner-only posting, subscriptions
- Bots: master bot, user bots, webhook/polling delivery, commands
- Web Push: VAPID-based, per-user/per-chat settings, auto-push on messages
- Files: streaming upload/download with access control
- WebRTC signaling: 1:1 and group calls
- SSE real-time events via Redis pub/sub
- Admin panel: Vue 3 SPA with CRUD, dashboard, settings
- CLI: user management, database operations
- HTTP/2 via TLS (rustls)
- Docker Compose with all services

### Not Implemented / Known Issues ⚠️

| Feature | Status | Notes |
|---------|--------|-------|
| Web Client | Stub | Vue 3 PWA not created |
| Delivery/read status | Partial | Only 'sent' status stored |
| Typing indicators | Partial | Published via Redis, not persisted |
| File encryption at rest | No | UUID filenames, no content encryption |
| Group call architecture | Limitation | Per-participant records |
| Rate limiting | No | No brute-force protection |
| Web Push encryption | Simplified | VAPID auth only; full ECDH + HTTP-ECE pending |

## Development Conventions

- **No `unwrap()`** — use `?` or `expect()` with messages
- **Error handling**: `thiserror` for custom errors, Axum `IntoResponse` for HTTP
- **Logging**: `tracing` crate with JSON formatter
- **Timestamps**: UTC (`TIMESTAMPTZ` + `chrono::Utc`)
- **Self-hosted**: no public registration unless `ALLOW_REGISTRATION=true`
- **E2E encryption**: X25519 keypairs on registration (server-trusted)
- **TOTP**: SHA1, AES-GCM encrypted at rest
- **Backup codes**: individually argon2-hashed
- **Admin TOTP mandatory**: cannot access any API without it
