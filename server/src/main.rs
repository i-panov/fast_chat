mod cli;
mod config;
mod crypto;
mod db;
mod error;
mod middleware;
mod models;
mod proto;
mod rest;
mod services;

use clap::Parser;
use std::sync::Arc;
use tonic::transport::Server;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::cli::Cli;
use crate::config::Settings;
use crate::crypto::CryptoService;
use crate::db::postgres::PostgresPool;
use crate::db::redis::RedisPool;
use crate::models::User;
use crate::proto::auth::auth_server::AuthServer;
use crate::proto::files::files_server::FilesServer;
use crate::proto::messaging::messaging_server::MessagingServer;
use crate::proto::signaling::signaling_server::SignalingServer;
use crate::proto::users::users_server::UsersServer;
use crate::services::{
    auth::AuthService, files::FilesService, messaging::MessagingService,
    signaling::SignalingService, users::UsersService,
};

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

    let settings = Settings {
        database_url: cli.database_url(),
        redis_url: cli.redis_url(),
        jwt_secret: cli.jwt_secret()?,
        jwt_expiry_hours: 24,
        files_dir: cli.files_dir(),
        server_addr: cli.addr.clone(),
        coturn_host: "localhost".to_string(),
        coturn_port: 3478,
        ion_sfu_url: std::env::var("ION_SFU_URL").ok(),
    };

    info!("Starting Fast Chat server on {}", settings.server_addr);

    let postgres_pool = PostgresPool::new(&settings.database_url).await?;
    let redis_pool = RedisPool::new(&settings.redis_url).await?;

    tokio::fs::create_dir_all(&settings.files_dir).await?;

    let state = Arc::new(AppState {
        settings: settings.clone(),
        db: postgres_pool,
        redis: redis_pool,
    });

    let addr = settings.server_addr.parse()?;
    let rest_port = 8080;

    info!("gRPC server listening on {}", addr);
    info!("REST API listening on http://0.0.0.0:{}", rest_port);

    let grpc_state = state.clone();
    let rest_state = state.clone();

    // Run REST API on separate port
    tokio::spawn(async move {
        let rest_app = rest::create_router(rest_state);
        let rest_addr = format!("0.0.0.0:{}", rest_port);
        let listener = match tokio::net::TcpListener::bind(&rest_addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("Failed to bind REST API to {}: {}", rest_addr, e);
                return;
            }
        };
        info!("REST API started on {}", rest_addr);
        if let Err(e) = axum::serve(listener, rest_app).await {
            tracing::error!("REST API error: {}", e);
        }
    });

    // Run gRPC server
    Server::builder()
        .add_service(AuthServer::new(AuthService::new(grpc_state.clone())))
        .add_service(UsersServer::new(UsersService::new(grpc_state.clone())))
        .add_service(MessagingServer::new(MessagingService::new(grpc_state.clone())))
        .add_service(FilesServer::new(FilesService::new(grpc_state.clone())))
        .add_service(SignalingServer::new(SignalingService::new(grpc_state.clone())))
        .serve(addr)
        .await?;

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
