use clap::Parser;
use sqlx::Row;
use std::env;

#[derive(Parser)]
struct Cli {
    #[arg(long, default_value = "http://localhost:8080")]
    server: String,
    #[arg(long)]
    database_url: Option<String>,
    #[clap(subcommand)]
    command: Option<Commands>,
}

#[derive(clap::Subcommand)]
enum Commands {
    User {
        #[clap(subcommand)]
        subcommand: Option<UserCommands>,
    },
    Db {
        #[clap(subcommand)]
        subcommand: Option<DbCommands>,
    },
}

#[derive(clap::Subcommand)]
enum UserCommands {
    Create {
        #[arg(long)]
        username: String,
        #[arg(long)]
        email: String,
        #[arg(long, default_value = "false")]
        admin: bool,
    },
    List,
    SetAdmin {
        #[arg(long)]
        id: String,
        #[arg(long)]
        yes: bool,
    },
    SetDisabled {
        #[arg(long)]
        id: String,
        #[arg(long)]
        yes: bool,
    },
    InitAdmin {
        #[arg(long)]
        username: String,
        #[arg(long)]
        email: String,
    },
}

#[derive(clap::Subcommand)]
enum DbCommands {
    Migrate,
    Reset {
        #[arg(long, default_value = "false")]
        force: bool,
    },
    Status,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let db = cli
        .database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| "postgres://fast_chat:changeme@localhost:5432/fast_chat".to_string());

    match cli.command {
        Some(Commands::User { subcommand }) => {
            match subcommand {
                Some(UserCommands::Create { username, email, admin }) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    let (public_key, _) = generate_keypair();
                    let id = uuid::Uuid::new_v4();
                    let now = chrono::Utc::now();

                    sqlx::query(
                        r#"
                        INSERT INTO users (id, username, email, public_key, is_admin, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (username) DO UPDATE SET email = $3, public_key = $4, updated_at = $6
                        "#
                    )
                    .bind(id)
                    .bind(&username)
                    .bind(&email)
                    .bind(&public_key)
                    .bind(admin)
                    .bind(now)
                    .bind(now)
                    .execute(&pool)
                    .await?;

                    println!("User created: {} ({}) - admin: {}", username, email, admin);
                }
                Some(UserCommands::List) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    use sqlx::FromRow;
                    #[derive(FromRow)]
                    struct UserRow {
                        id: uuid::Uuid,
                        username: String,
                        email: String,
                        is_admin: bool,
                    }

                    let users = sqlx::query_as::<_, UserRow>("SELECT id, username, email, is_admin FROM users ORDER BY created_at DESC")
                        .fetch_all(&pool)
                        .await?;

                    println!("{:<36} {:<20} {:<30} {:<10}", "ID", "USERNAME", "EMAIL", "ADMIN");
                    println!("{}", "-".repeat(96));
                    for user in users {
                        println!("{:<36} {:<20} {:<30} {:<10}", user.id, user.username, user.email, user.is_admin);
                    }
                }
                Some(UserCommands::SetAdmin { id, yes }) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID")?;
                    sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
                        .bind(yes)
                        .bind(uuid)
                        .execute(&pool)
                        .await?;
                    println!("User {} admin status set to {}", id, yes);
                }
                Some(UserCommands::SetDisabled { id, yes }) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID")?;
                    sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
                        .bind(yes)
                        .bind(uuid)
                        .execute(&pool)
                        .await?;
                    println!("User {} disabled status set to {}", id, yes);
                }
                Some(UserCommands::InitAdmin { username, email }) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    let id = uuid::Uuid::new_v4();
                    sqlx::query(
                        "INSERT INTO users (id, username, email, is_admin, created_at, updated_at) VALUES ($1, $2, $3, TRUE, NOW(), NOW())"
                    )
                    .bind(id)
                    .bind(&username)
                    .bind(&email)
                    .execute(&pool)
                    .await?;
                    println!("Admin created: {} ({})", username, email);
                    println!();
                    println!("⚠️  IMPORTANT: Admin accounts require 2FA (TOTP) to be enabled.");
                    println!("   This admin cannot log in until TOTP is configured.");
                    println!("   Please set up TOTP using the admin panel or API after first login.");
                }
                None => {
                    println!("User subcommands: create, list, set-admin, set-disabled, init-admin");
                }
            }
        }
        Some(Commands::Db { subcommand }) => {
            match subcommand {
                Some(DbCommands::Migrate) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;

                    let migrations_dir = std::path::PathBuf::from("../migrations");
                    let migrations = std::fs::read_dir(&migrations_dir)?
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().extension().is_some_and(|ext| ext == "sql"))
                        .collect::<Vec<_>>();
                    let mut migrations = migrations.into_iter().collect::<Vec<_>>();
                    migrations.sort_by_key(|a| a.file_name());
                    for entry in migrations {
                        let sql = std::fs::read_to_string(entry.path())?;
                        for stmt in sql.split(';') {
                            if !stmt.trim().is_empty() {
                                sqlx::query(stmt).execute(&pool).await?;
                            }
                        }
                        println!("  ✓ {}", entry.file_name().to_string_lossy());
                    }
                }
                Some(DbCommands::Reset { force }) => {
                    if !force {
                        println!("This will delete ALL data. Use --force to confirm.");
                        return Ok(());
                    }
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;
                    sqlx::query("DROP SCHEMA public CASCADE").execute(&pool).await?;
                    sqlx::query("CREATE SCHEMA public").execute(&pool).await?;
                    println!("Database reset complete.");
                }
                Some(DbCommands::Status) => {
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&db)
                        .await?;
                    let tables = sqlx::query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                        .fetch_all(&pool)
                        .await?;
                    for row in tables {
                        println!("  - {}", row.get::<String, _>("tablename"));
                    }
                }
                None => {
                    println!("DB subcommands: migrate, reset, status");
                }
            }
        }
        None => {
            println!("FastChat CLI - Available commands:");
            println!("  user create  --username X --email X [--admin]");
            println!("  user list");
            println!("  user set-admin --id X --yes (true/false)");
            println!("  user set-disabled --id X --yes (true/false)");
            println!("  user init-admin --username X --email X");
            println!("  db migrate");
            println!("  db reset --force");
            println!("  db status");
        }
    }
    Ok(())
}

fn generate_keypair() -> (String, String) {
    use x25519_dalek::{EphemeralSecret, PublicKey};
    use rand::rngs::OsRng;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    let secret = EphemeralSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    let public_key = BASE64.encode(public.as_bytes());
    let private_key = String::new();
    (public_key, private_key)
}
