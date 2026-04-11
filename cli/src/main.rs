use clap::Parser;
use sqlx::postgres::PgPoolOptions;
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

fn get_db_url(cli: &Cli) -> String {
    cli.database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| {
            eprintln!("ERROR: DATABASE_URL not set and --database-url not provided");
            std::process::exit(1);
        })
}

async fn connect_db(db_url: &str) -> Result<sqlx::PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(1)
        .connect(db_url)
        .await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let db_url = get_db_url(&cli);

    match cli.command {
        Some(Commands::User { subcommand }) => match subcommand {
            Some(UserCommands::Create {
                username,
                email,
                admin,
            }) => {
                let pool = connect_db(&db_url)
                    .await
                    .map_err(|e| format!("Database connection failed: {}", e))?;

                let id = uuid::Uuid::new_v4();

                sqlx::query(
                    r#"
                        INSERT INTO users (id, username, email, is_admin, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, NOW(), NOW())
                        ON CONFLICT (username) DO UPDATE SET email = $2, updated_at = NOW()
                        "#,
                )
                .bind(id)
                .bind(&username)
                .bind(&email)
                .bind(admin)
                .execute(&pool)
                .await
                .map_err(|e| format!("Failed to create user: {}", e))?;

                println!("User created: {} ({}) - admin: {}", username, email, admin);
                println!("Note: Public key should be set by the client app.");
            }
            Some(UserCommands::List) => {
                let pool = connect_db(&db_url)
                    .await
                    .map_err(|e| format!("Database connection failed: {}", e))?;

                use sqlx::FromRow;
                #[derive(FromRow)]
                struct UserRow {
                    id: uuid::Uuid,
                    username: String,
                    email: String,
                    is_admin: bool,
                }

                let users = sqlx::query_as::<_, UserRow>(
                    "SELECT id, username, email, is_admin FROM users ORDER BY created_at DESC",
                )
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("Failed to list users: {}", e))?;

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
            Some(UserCommands::SetAdmin { id, yes }) => {
                let pool = connect_db(&db_url)
                    .await
                    .map_err(|e| format!("Database connection failed: {}", e))?;

                let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID format")?;
                sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
                    .bind(yes)
                    .bind(uuid)
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Failed to update user: {}", e))?;
                println!("User {} admin status set to {}", id, yes);
            }
            Some(UserCommands::SetDisabled { id, yes }) => {
                let pool = connect_db(&db_url)
                    .await
                    .map_err(|e| format!("Database connection failed: {}", e))?;

                let uuid: uuid::Uuid = id.parse().map_err(|_| "Invalid UUID format")?;
                sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
                    .bind(yes)
                    .bind(uuid)
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Failed to update user: {}", e))?;
                println!("User {} disabled status set to {}", id, yes);
            }
            Some(UserCommands::InitAdmin { username, email }) => {
                let pool = connect_db(&db_url)
                    .await
                    .map_err(|e| format!("Database connection failed: {}", e))?;

                let id = uuid::Uuid::new_v4();
                sqlx::query(
                        "INSERT INTO users (id, username, email, is_admin, created_at, updated_at) VALUES ($1, $2, $3, TRUE, NOW(), NOW())"
                    )
                    .bind(id)
                    .bind(&username)
                    .bind(&email)
                    .execute(&pool)
                    .await.map_err(|e| {
                        format!("Failed to create admin: {}", e)
                    })?;
                println!("Admin created: {} ({})", username, email);
                println!();
                println!("IMPORTANT: Admin accounts require 2FA (TOTP) to be enabled.");
                println!("   This admin cannot log in until TOTP is configured.");
                println!("   Please set up TOTP using the admin panel or API after first login.");
            }
            None => {
                println!("User subcommands: create, list, set-admin, set-disabled, init-admin");
            }
        },
        Some(Commands::Db { subcommand }) => {
            match subcommand {
                Some(DbCommands::Migrate) => {
                    let pool = connect_db(&db_url)
                        .await
                        .map_err(|e| format!("Database connection failed: {}", e))?;

                    sqlx::query(
                        "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(20) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)"
                    ).execute(&pool).await.map_err(|e| {
                        format!("Failed to create migrations table: {}", e)
                    })?;

                    let migrations_dir = std::path::PathBuf::from("../migrations");
                    let entries = std::fs::read_dir(&migrations_dir)?
                        .filter_map(|e| e.ok())
                        .filter(|e| e.path().extension().is_some_and(|ext| ext == "sql"))
                        .collect::<Vec<_>>();
                    let mut entries = entries.into_iter().collect::<Vec<_>>();
                    entries.sort_by_key(|a| a.file_name());

                    let mut applied = 0;
                    for entry in entries {
                        let version = entry.file_name().to_string_lossy().to_string();

                        let exists: (bool,) = sqlx::query_as(
                            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)",
                        )
                        .bind(&version)
                        .fetch_one(&pool)
                        .await?;

                        if exists.0 {
                            println!("  - {} (already applied)", version);
                            continue;
                        }

                        let sql = std::fs::read_to_string(entry.path())?;
                        for stmt in sql.split(';') {
                            if !stmt.trim().is_empty() {
                                sqlx::query(stmt)
                                    .execute(&pool)
                                    .await
                                    .map_err(|e| format!("Migration {} failed: {}", version, e))?;
                            }
                        }

                        sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())")
                            .bind(&version)
                            .execute(&pool)
                            .await?;

                        println!("  ✓ {}", version);
                        applied += 1;
                    }

                    if applied == 0 {
                        println!("No new migrations to apply.");
                    } else {
                        println!("Applied {} migration(s).", applied);
                    }
                }
                Some(DbCommands::Reset { force }) => {
                    if !force {
                        println!("This will delete ALL data. Use --force to confirm.");
                        return Ok(());
                    }
                    let pool = connect_db(&db_url)
                        .await
                        .map_err(|e| format!("Database connection failed: {}", e))?;
                    sqlx::query("DROP SCHEMA public CASCADE")
                        .execute(&pool)
                        .await?;
                    sqlx::query("CREATE SCHEMA public").execute(&pool).await?;
                    sqlx::query(
                        "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(20) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)"
                    ).execute(&pool).await?;
                    println!("Database reset complete.");
                }
                Some(DbCommands::Status) => {
                    let pool = connect_db(&db_url)
                        .await
                        .map_err(|e| format!("Database connection failed: {}", e))?;
                    let tables =
                        sqlx::query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                            .fetch_all(&pool)
                            .await
                            .map_err(|e| format!("Failed to get database status: {}", e))?;
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
