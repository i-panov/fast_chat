FROM rust:bookworm AS builder

RUN apt-get update && apt-get install -y protobuf-compiler libssl-dev pkg-config

WORKDIR /build

# Контекст сборки — корень проекта (fast_chat/)
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs
RUN cargo fetch
RUN rm src/main.rs

COPY server/src/ ./src/
COPY proto/ ./proto/
RUN cargo build --release --bin fast-chat-server

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates libssl3 procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/target/release/fast-chat-server /app/

# Копируем миграции
COPY migrations/ ./migrations/

# Symlink для CLI (ищет ../migrations)
RUN ln -sf /app/migrations /migrations

EXPOSE 50051
EXPOSE 8080

CMD ["/app/fast-chat-server"]
