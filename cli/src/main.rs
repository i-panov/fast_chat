use clap::Parser;
use regex::Regex;
use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use std::env;
use std::io::{self, Write};
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Parser)]
struct Cli {
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
    List {
        #[arg(long, default_value = "false")]
        json: bool,
    },
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

#[derive(Serialize, sqlx::FromRow)]
struct UserRow {
    id: String,
    username: String,
    email: String,
    is_admin: bool,
}

fn get_db_url(cli: &Cli) -> String {
    cli.database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| {
            error!("ERROR: DATABASE_URL not set and --database-url not provided");
            std::process::exit(1);
        })
}

async fn connect_db(db_url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(1)
        .connect(db_url)
        .await
}

fn validate_username(username: &str) -> Result<(), String> {
    if username.is_empty() {
        return Err("Username cannot be empty".to_string());
    }
    if username.len() > 50 {
        return Err("Username too long".to_string());
    }
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err("Username must be alphanumeric with underscores only".to_string());
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<(), String> {
    if email.is_empty() {
        return Err("Email cannot be empty".to_string());
    }
    if email.len() > 255 {
        return Err("Email too long".to_string());
    }
    let email_regex = Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$").unwrap();
    if !email_regex.is_match(email) {
        return Err("Invalid email format".to_string());
    }
    Ok(())
}

async fn confirm_action(prompt: &str) -> Result<bool, Box<dyn std::error::Error>> {
    print!("{} (type 'YES' to confirm): ", prompt);
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    Ok(input.trim() == "YES")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cli = Cli::parse();
    let db_url = get_db_url(&cli);

    match cli.command {
        Some(Commands::User { subcommand }) => match subcommand {
            Some(UserCommands::Create {
                username,
                email,
                admin,
            }) => {
                validate_username(&username)?;
                validate_email(&email)?;

                let pool = connect_db(&db_url).await?;

                let existing: (bool,) =
                    sqlx::query_as("SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)")
                        .bind(&username)
                        .fetch_one(&pool)
                        .await?;

                if existing.0 {
                    return Err(format!("User with username '{}' already exists", username).into());
                }

                let mut tx = pool.begin().await?;
                let id = Uuid::new_v4();
                sqlx::query(
                    r#"
                        INSERT INTO users (id, username, email, is_admin, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, NOW(), NOW())
                        "#,
                )
                .bind(id)
                .bind(&username)
                .bind(&email)
                .bind(admin)
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;

                info!("User created: {} ({}) - admin: {}", username, email, admin);
                println!("Note: Public key should be set by the client app.");
            }
            Some(UserCommands::List { json }) => {
                let pool = connect_db(&db_url).await?;

                let users = sqlx::query_as::<_, UserRow>(
                    "SELECT id::text, username, email, is_admin FROM users ORDER BY created_at DESC",
                )
                .fetch_all(&pool)
                .await?;

                if json {
                    println!("{}", serde_json::to_string_pretty(&users)?);
                } else {
                    println!(
                        "{:<36} {:<20} {:<30} {:<10}",
                        "ID", "USERNAME", "EMAIL", "ADMIN"
                    );
                    println!("{}", "-".repeat(96));
                    for user in users {
                        println!(
                            "{:<36} {:<20} {:<30} {:<10}",
                            user.id, user.username, user.email, user.is_admin
                        );
                    }
                }
            }
            Some(UserCommands::SetAdmin { id, yes }) => {
                let pool = connect_db(&db_url).await?;
                let uuid = Uuid::parse_str(&id)?;

                let mut tx = pool.begin().await?;
                sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
                    .bind(yes)
                    .bind(uuid)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                info!("User {} admin status set to {}", id, yes);
            }
            Some(UserCommands::SetDisabled { id, yes }) => {
                let pool = connect_db(&db_url).await?;
                let uuid = Uuid::parse_str(&id)?;

                let mut tx = pool.begin().await?;
                sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
                    .bind(yes)
                    .bind(uuid)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                info!("User {} disabled status set to {}", id, yes);
            }
            Some(UserCommands::InitAdmin { username, email }) => {
                validate_username(&username)?;
                validate_email(&email)?;

                let pool = connect_db(&db_url).await?;
                let mut tx = pool.begin().await?;
                let id = Uuid::new_v4();
                sqlx::query(
                        "INSERT INTO users (id, username, email, is_admin, created_at, updated_at) VALUES ($1, $2, $3, TRUE, NOW(), NOW())"
                    )
                    .bind(id)
                    .bind(&username)
                    .bind(&email)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                warn!("Admin created: {} ({})", username, email);
                println!();
                println!("IMPORTANT: Admin accounts require 2FA (TOTP) to be enabled.");
                println!("   This admin cannot log in until TOTP is configured.");
                println!("   Please set up TOTP using the admin panel or API after first login.");
            }
            None => {
                println!(
                    "User subcommands: create, list [--json], set-admin, set-disabled, init-admin"
                );
            }
        },
        Some(Commands::Db { subcommand }) => {
            match subcommand {
                Some(DbCommands::Migrate) => {
                    let pool = connect_db(&db_url).await?;
                    let mut tx = pool.begin().await?;

                    sqlx::query(
                        "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(20) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)"
                    ).execute(&mut *tx).await?;

                    let migrations_dir = std::path::PathBuf::from("../migrations");
                    let mut entries: Vec<_> = std::fs::read_dir(&migrations_dir)?
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().extension().is_some_and(|ext| ext == "sql"))
                        .collect();
                    entries.sort_by_key(|a| a.file_name());

                    let mut applied = 0;
                    for entry in entries {
                        let filename = entry.file_name().to_string_lossy().to_string();
                        let version_num = parse_migration_version(&filename)?;

                        let exists: (bool,) = sqlx::query_as(
                            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)",
                        )
                        .bind(version_num.to_string())
                        .fetch_one(&mut *tx)
                        .await?;

                        if exists.0 {
                            info!("Migration {} already applied", filename);
                            continue;
                        }

                        let sql = std::fs::read_to_string(entry.path())?;
                        for stmt in sql.split(';') {
                            if !stmt.trim().is_empty() {
                                sqlx::query(stmt).execute(&mut *tx).await?;
                            }
                        }

                        sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())")
                            .bind(version_num.to_string())
                            .execute(&mut *tx)
                            .await?;

                        info!("Applied migration {}", filename);
                        applied += 1;
                    }

                    tx.commit().await?;

                    if applied == 0 {
                        info!("No new migrations to apply.");
                    } else {
                        info!("Applied {} migration(s).", applied);
                    }
                }
                Some(DbCommands::Reset { force }) => {
                    if !force || !confirm_action("This will delete ALL data").await? {
                        return Ok(());
                    }
                    let pool = connect_db(&db_url).await?;
                    sqlx::query("DROP SCHEMA public CASCADE")
                        .execute(&pool)
                        .await?;
                    sqlx::query("CREATE SCHEMA public").execute(&pool).await?;
                    sqlx::query(
                        "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(20) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)"
                    ).execute(&pool).await?;
                    warn!("Database reset complete.");
                }
                Some(DbCommands::Status) => {
                    let pool = connect_db(&db_url).await?;
                    let tables =
                        sqlx::query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                            .fetch_all(&pool)
                            .await?;
                    for row in tables {
                        println!("  - {}", row.get::<String, _>("tablename"));
                    }
                }
                None => {
                    println!("DB subcommands: migrate, reset [--force], status");
                }
            }
        }
        None => {
            println!("FastChat CLI - Available commands:");
            println!("  user create  --username X --email X [--admin]");
            println!("  user list [--json]");
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

fn parse_migration_version(filename: &str) -> Result<i32, String> {
    filename
        .split('_')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("Invalid migration filename: {}", filename))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_username() {
        assert!(validate_username("alice").is_ok());
        assert!(validate_username("alice_123").is_ok());
        assert!(validate_username("").is_err());
        assert!(validate_username("alice@example.com").is_err()); // has @
        assert!(validate_username(&"a".repeat(51)).is_err());
    }

    #[test]
    fn test_validate_email() {
        assert!(validate_email("alice@example.com").is_ok());
        assert!(validate_email("alice.smith+tag@example.com").is_ok());
        assert!(validate_email("").is_err());
        assert!(validate_email("alice").is_err());
        assert!(validate_email("alice@").is_err());
    }

    #[test]
    fn test_parse_migration_version() {
        assert_eq!(parse_migration_version("001_hidden_chats.sql").unwrap(), 1);
        assert!(parse_migration_version("hidden_chats.sql").is_err());
        assert!(parse_migration_version("abc_hidden_chats.sql").is_err());
    }
}
