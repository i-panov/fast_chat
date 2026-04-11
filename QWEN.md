# QWEN.md — Fast Chat Project Context

## Project Overview

**Fast Chat** is a self-hosted real-time messenger application with end-to-end (E2E) encryption, file transfers, audio/video calls, and group chats. It features a gRPC backend built with Rust, PostgreSQL + Redis for data/storage, and planned Vue 3 PWA web clients with full offline support.

### Architecture

| Layer | Technology |
|-------|------------|
| **Backend** | Rust, Tonic (gRPC), Prost (protobuf), Tokio (async runtime) |
| **Database** | PostgreSQL 16 + Redis 7 |
| **Auth** | JWT access/refresh tokens + TOTP 2FA (argon2 password hashing) |
| **Messaging** | gRPC streaming with Redis pub/sub for real-time delivery |
| **WebRTC** | coturn (STUN/TURN) + Ion SFU (group calls) |
| **CLI** | Rust + clap (admin user/DB management) |
| **Admin Panel** | Vue 3 + Vuetify SPA (fully implemented — CRUD, dashboard, settings) |
| **Admin API** | REST (Axum) — JWT-protected, admin-only routes |
| **Web Client** | Vue 3 + Vuetify PWA (stub — not implemented) |

### Directory Structure

```
fast_chat/
├── proto/                      # Protobuf definitions (7 files)
├── migrations/                 # SQL migrations (001_initial.sql, 002_features.sql)
├── server/                     # Tonic gRPC server (Rust)
│   ├── src/
│   │   ├── main.rs             # Entry point + CLI commands
│   │   ├── config.rs           # Settings/configuration
│   │   ├── error.rs            # Custom error types (thiserror)
│   │   ├── cli/                # CLI command definitions
│   │   ├── crypto/             # CryptoService (X25519, Argon2, ChaCha20Poly1305)
│   │   ├── db/                 # PostgreSQL + Redis connection pools
│   │   ├── middleware/         # JWT authentication helpers
│   │   ├── models/             # SQLx models (User, Chat, Message, etc.)
│   │   ├── proto/              # Generated Rust code from proto files
│   │   └── services/           # gRPC service implementations
│   └── Dockerfile
├── cli/                        # CLI binary (admin operations)
├── web-client/                 # Vue 3 PWA stub
├── admin-panel/                # Vue 3 admin UI stub
├── wasm-sdk/                   # WebAssembly SDK (for web client crypto)
├── coturn/                     # TURN server config
├── ion-sfu/                    # SFU config for group calls
└── docker-compose.yml
```

## Building and Running

### Prerequisites

```bash
# Install protobuf compiler
# Ubuntu/Debian:
sudo apt-get install protobuf-compiler

# macOS:
brew install protobuf

# Rust toolchain (1.78+)
rustup toolchain install stable
```

### Server

```bash
cd server
cargo build --release
cargo run --release                    # Start gRPC server on :50051
```

### CLI

```bash
cd cli
cargo build --release

# Or use the server binary (includes CLI commands):
cd server
cargo run --release -- <command>
```

### CLI Commands

```bash
# User management
fast-chat-cli user create --username alice --email alice@example.com --password <pass>
fast-chat-cli user list
fast-chat-cli user update --id <uuid> --username newname
fast-chat-cli user delete --id <uuid>
fast-chat-cli user set-admin --id <uuid> --yes true
fast-chat-cli user init-admin --username admin --email admin@example.com --password <pass>

# Database
fast-chat-cli db migrate               # Apply migrations from ../migrations/
fast-chat-cli db reset --force         # Drop and recreate schema
```

### Docker Compose

```bash
# Start all services
docker-compose up -d

# Services and ports:
#   PostgreSQL: 5432
#   Redis:      6379
#   coturn:     3478 (TCP/UDP), 5349 (TCP/UDP)
#   Ion SFU:    5000
#   Server:     50051
#   Web Client: 8080
#   Admin Panel: 8081
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://fast_chat:changeme@localhost:5432/fast_chat` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_SECRET` | JWT signing secret | `changeme` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `changeme` |
| `EXTERNAL_IP` | External IP for coturn/SFU | `0.0.0.0` |
| `COTURN_HOST` | coturn hostname | `coturn` |
| `ION_SFU_URL` | Ion SFU URL | `ion-sfu:5000` |
| `FILES_DIR` | File upload directory | `./files` |

### Code Quality

```bash
# Server
cd server && cargo fmt --check && cargo clippy --all-targets --all-features

# CLI
cd cli && cargo fmt --check && cargo clippy --all-targets --all-features
```

## gRPC Services

### Proto Files (`proto/`)

| File | Service | Purpose |
|------|---------|---------|
| `common.proto` | — | Shared messages (User, Chat, Message, FileMetadata, Ack, etc.) |
| `auth.proto` | `AuthService` | register, login, refresh_token, get_current_user |
| `users.proto` | `UsersService` | User CRUD, 2FA setup/verify/enable/disable |
| `messaging.proto` | `MessagingService` | Chats, messages, threads, topics, pinned messages |
| `files.proto` | `FilesService` | Streaming file upload/download |
| `signaling.proto` | `SignalingService` | WebRTC call management (1:1 + group) |
| `admin.proto` | `AdminService` | Health check with uptime metrics |

## Database Schema

### Core Tables

- **users** — Authentication, public keys, 2FA settings (argon2 password hashing, TOTP)
- **user_sessions** — Refresh token tracking (currently not validated)
- **chats** — Direct and group chats
- **chat_participants** — Many-to-many chat membership (composite PK)
- **messages** — E2E encrypted messages with content_type, topic/thread support
- **files** — File metadata for uploads
- **active_calls** — WebRTC call state

### Feature Tables (002_features.sql)

- **pinned_messages** — Per-user and global message pins
- **threads** — Message reply threads
- **topics** — Group chat channels

### Full Schema Reference

See `AGENTS.md` for the complete SQL schema with all columns, constraints, and indexes.

## Crypto & Security

- **Password hashing**: argon2 (argon2 crate v0.5)
- **E2E encryption**: X25519 keypairs (x25519-dalek), ChaCha20Poly1305 for message encryption
- **2FA**: TOTP with SHA1 (totp-lite crate v2)
- **JWT**: HS256 access tokens (jsonwebtoken crate v9), refresh tokens tracked in DB
- **No public registration**: All users created by admin via CLI

## Current Status

### Implemented ✅

- All 7 proto files and gRPC service definitions
- PostgreSQL schema with migrations (001_initial.sql, 002_features.sql)
- AuthService — JWT auth with TOTP 2FA and backup codes
- UsersService — User CRUD, 2FA setup/verify/enable/disable
- MessagingService — Chats, messages, threads, topics, pinned messages
- FilesService — Streaming file upload/download
- SignalingService — 1:1 and group call management
- AdminService — Health check with uptime metrics
- CLI — User management and database operations
- Redis pub/sub for real-time messaging
- Docker Compose with all services
- Chat participation checks enforced

### Not Implemented / Known Issues ⚠️

| Feature | Status | Details |
|---------|--------|---------|
| Web Client | Stub | Vue 3 + Vuetify PWA not created |
| Admin Panel | Stub | Vue 3 admin UI not created |
| Backup codes API | Stub | `get_backup_codes` returns dummy `"XXXX-XXXX"` |
| ICE candidate relay | Missing | Logged but not relayed to peers (`signaling.rs:180-187`) |
| Refresh token validation | Partial | JWT signature checked but not DB session validation |
| Unread counts | Missing | Not tracked in database |
| Delivery/read status | Partial | Only 'sent' status stored |
| Typing indicators | Partial | Proto exists but not implemented |

## Development Conventions

- **No `unwrap()` in production code** — use `?` or `expect()` with messages
- **Error handling**: `thiserror` for custom error types, gRPC `Status` for transport
- **Logging**: `tracing` crate with JSON formatter for production
- **Timestamps**: UTC everywhere (`TIMESTAMPTZ` in Postgres, `chrono::Utc` in Rust)
- **Proto files**: Located in `proto/`, compiled by `server/build.rs` into `server/src/proto/`
- **Self-hosted**: No public registration — admin creates all users via CLI
- **E2E encryption**: X25519 keypairs generated on registration, private keys stored client-side only

## Key Files

| File | Purpose |
|------|---------|
| `server/src/main.rs` | Server entry point, CLI command dispatcher |
| `server/src/config.rs` | Settings/configuration loading |
| `server/src/error.rs` | Centralized error types with gRPC Status mapping |
| `server/src/services/*.rs` | All gRPC service implementations |
| `server/src/crypto/` | Crypto utilities (hashing, keypairs, encryption) |
| `server/src/db/` | PostgreSQL and Redis connection pool wrappers |
| `server/src/middleware/` | JWT authentication middleware |
| `docker-compose.yml` | Full service orchestration |
| `migrations/*.sql` | Database schema migrations |
