mod cli;
mod config;
mod crypto;
mod db;
mod error;
mod middleware;
mod models;
mod routes;
mod sse;

use clap::Parser;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::cli::Cli;
use crate::config::Settings;
use crate::crypto::CryptoService;
use crate::db::postgres::PostgresPool;
use crate::db::redis::RedisPool;
use crate::models::User;

/// Initialize the master bot if it doesn't exist
async fn init_master_bot(pool: &crate::db::postgres::PostgresPool) -> Result<Option<String>, Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    use base64::{engine::general_purpose::{URL_SAFE_NO_PAD, STANDARD}, Engine};

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM bots WHERE is_master = TRUE)")
        .fetch_one(pool.get_pool())
        .await?;

    if exists {
        return Ok(None);
    }

    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token = format!("bot_{}", URL_SAFE_NO_PAD.encode(bytes));
    let token_hash = STANDARD.encode(Sha256::digest(token.as_bytes()));

    let now = chrono::Utc::now();

    sqlx::query(
        "INSERT INTO bots (id, owner_id, username, display_name, access_token_hash, is_master, is_active, delivery_mode, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'polling', $6, $7)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(uuid::Uuid::nil())
    .bind("master_bot")
    .bind("Master Bot")
    .bind(&token_hash)
    .bind(now)
    .bind(now)
    .execute(pool.get_pool())
    .await?;

    Ok(Some(token))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,fast_chat_server=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    if let Some(ref command) = cli.command {
        run_cli_command(&cli, command).await?;
        return Ok(());
    }

    let jwt_secret = cli.jwt_secret()?;
    let settings: Settings = Settings {
        database_url: cli.database_url(),
        redis_url: cli.redis_url(),
        jwt_secret,
        jwt_expiry_hours: 24,
        refresh_token_expiry_days: 7,
        files_dir: cli.files_dir(),
        server_addr: cli.addr.clone(),
        coturn_host: std::env::var("COTURN_HOST").unwrap_or_else(|_| "localhost".to_string()),
        coturn_port: std::env::var("COTURN_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3478),
        ion_sfu_url: std::env::var("ION_SFU_URL").ok(),
        tls_cert_path: std::env::var("TLS_CERT_PATH").ok(),
        tls_key_path: std::env::var("TLS_KEY_PATH").ok(),
        allow_registration: std::env::var("ALLOW_REGISTRATION").ok().map(|v| v == "true" || v == "1").unwrap_or(false),
        require_2fa: std::env::var("REQUIRE_2FA").ok().map(|v| v == "true" || v == "1").unwrap_or(false),
    };

    info!("Starting Fast Chat server on {}", settings.server_addr);

    let postgres_pool = PostgresPool::new(&settings.database_url).await?;
    let redis_pool = RedisPool::new(&settings.redis_url).await?;

    tokio::fs::create_dir_all(&settings.files_dir).await?;

    // Initialize master bot if it doesn't exist
    let master_bot_token = init_master_bot(&postgres_pool).await?;
    if let Some(ref token) = master_bot_token {
        info!("Master bot initialized. ACCESS_TOKEN: {}", token);
    }

    let state = Arc::new(AppState {
        settings: settings.clone(),
        db: postgres_pool,
        redis: redis_pool,
    });

    let addr: std::net::SocketAddrV4 = settings.server_addr.parse().expect("Invalid server_addr");

    let app = routes::create_router(state.clone());

    if let (Some(ref cert_path), Some(ref key_path)) = (&settings.tls_cert_path, &settings.tls_key_path) {
        info!("Starting with TLS (HTTP/2 enabled) on https://{}", addr);
        info!("  TLS cert: {}", cert_path);
        info!("  TLS key:  {}", key_path);

        let tls_config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
            .await
            .expect("Failed to load TLS certificates");

        axum_server::bind_rustls(addr.into(), tls_config)
            .serve(app.into_make_service())
            .await?;
    } else {
        info!("REST + SSE server listening on http://{} (HTTP/1.1, no TLS)", addr);
        info!("  To enable HTTP/2, set TLS_CERT_PATH and TLS_KEY_PATH env vars");

        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
    }

    info!("  POST   /api/auth/login         - Login");
    info!("  POST   /api/auth/refresh       - Refresh token");
    info!("  GET    /api/auth/me            - Current user");
    info!("  GET    /api/sse/connect        - SSE stream");
    info!("  GET    /api/users              - List users (admin)");
    info!("  POST   /api/users              - Create user (admin)");
    info!("  GET    /api/chats              - Get user chats");
    info!("  POST   /api/messages           - Send message");
    info!("  GET    /api/chats/:id/messages - Get messages");
    info!("  POST   /api/files/upload       - Upload file");
    info!("  GET    /api/files/:id          - Download file");
    info!("  POST   /api/calls              - Create call");
    info!("  GET    /api/health             - Health check");

    let app = routes::create_router(state.clone());

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn run_cli_command(
    cli: &Cli,
    command: &cli::Commands,
) -> Result<(), Box<dyn std::error::Error>> {
    let db = PostgresPool::new(&cli.database_url()).await?;

    match &command {
        cli::Commands::UserCreate {
            username,
            password,
            admin,
        } => {
            let password_hash = CryptoService::hash_password(password)
                .map_err(|e| format!("Failed to hash password: {}", e))?;
            let (public_key, _) = CryptoService::generate_keypair();
            let id = uuid::Uuid::new_v4();
            let now = chrono::Utc::now();

            sqlx::query(
                r#"
                INSERT INTO users (id, username, password_hash, public_key, is_admin, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (username) DO UPDATE SET password_hash = $3, public_key = $4, updated_at = $6
                "#
            )
            .bind(id)
            .bind(username)
            .bind(&password_hash)
            .bind(&public_key)
            .bind(admin)
            .bind(now)
            .bind(now)
            .execute(db.get_pool())
            .await?;

            println!("User created: {} - admin: {}", username, admin);
        }

        cli::Commands::UserList => {
            let users = sqlx::query_as::<_, User>("SELECT * FROM users ORDER BY created_at DESC")
                .fetch_all(db.get_pool())
                .await?;

            println!(
                "{:<36} {:<20} {:<10}",
                "ID", "USERNAME", "ADMIN"
            );
            println!("{}", "-".repeat(66));
            for user in users {
                println!(
                    "{:<36} {:<20} {:<10}",
                    user.id, user.username, user.is_admin
                );
            }
        }

        cli::Commands::UserSetAdmin { id, yes } => {
            let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID")?;
            sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
                .bind(yes)
                .bind(uuid)
                .execute(db.get_pool())
                .await?;
            println!("User {} admin status set to {}", id, yes);
        }

        cli::Commands::UserSetDisabled { id, yes } => {
            let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID")?;
            sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
                .bind(yes)
                .bind(uuid)
                .execute(db.get_pool())
                .await?;
            println!("User {} disabled status set to {}", id, yes);
        }

        cli::Commands::Migrate => {
            info!("Running migrations...");
            let mut files = std::fs::read_dir("../migrations")?.collect::<Result<Vec<_>, _>>()?;
            files.sort_by_key(|f| f.file_name());

            for file in files {
                let path = file.path();
                if path.extension().map(|e| e == "sql").unwrap_or(false) {
                    info!("Applying: {}", path.display());
                    let sql = std::fs::read_to_string(&path)?;
                    for statement in sql.split(';') {
                        let statement = statement.trim();
                        if !statement.is_empty() {
                            sqlx::query(statement).execute(db.get_pool()).await?;
                        }
                    }
                }
            }
            println!("Migrations completed");
        }

        cli::Commands::DbReset { force } => {
            if !force {
                println!("This will delete ALL data. Use --force to confirm.");
                return Ok(());
            }
            println!("Resetting database...");
            sqlx::query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
                .execute(db.get_pool())
                .await?;
            println!("Database reset. Run `fast-chat-server migrate` to reinitialize.");
        }
    }

    Ok(())
}

pub struct AppState {
    pub settings: Settings,
    pub db: PostgresPool,
    pub redis: RedisPool,
}
