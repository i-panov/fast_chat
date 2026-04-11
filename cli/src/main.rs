use clap::Parser;
use sqlx::Row;
use std::env;
use tonic::Request;

#[allow(clippy::large_enum_variant)]
#[allow(clippy::enum_variant_names)]
mod proto {
    pub mod common {
        include!("../proto/common.rs");
    }
    pub mod auth {
        include!("../proto/auth.rs");
    }
    pub mod users {
        include!("../proto/users.rs");
    }
    pub mod messaging {
        include!("../proto/messaging.rs");
    }
    pub mod files {
        include!("../proto/files.rs");
    }
    pub mod signaling {
        include!("../proto/signaling.rs");
    }
}

#[derive(Parser)]
struct Cli {
    #[arg(long, default_value = "http://localhost:50051")]
    server: String,
    #[arg(long)]
    database_url: Option<String>,
    #[arg(long)]
    command: Option<String>,
    #[arg(long)]
    username: Option<String>,
    #[arg(long)]
    email: Option<String>,
    #[arg(long)]
    password: Option<String>,
    #[arg(long)]
    page: Option<i32>,
    #[arg(long)]
    page_size: Option<i32>,
    #[arg(long)]
    id: Option<String>,
    #[arg(long)]
    yes: Option<bool>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let db = cli
        .database_url
        .or_else(|| env::var("DATABASE_URL").ok())
        .unwrap_or_else(|| "postgres://fast_chat:changeme@localhost:5432/fast_chat".to_string());

    match cli.command.as_deref() {
        Some("user") | Some("user create") => {
            let username = cli.username.clone().ok_or("username required")?;
            let email = cli.email.clone().ok_or("email required")?;
            let password = cli.password.clone().ok_or("password required")?;
            let mut client = proto::users::users_client::UsersClient::connect(cli.server).await?;
            let request = Request::new(proto::users::CreateUserRequest {
                username,
                email,
                password,
            });
            let response = client.create_user(request).await?.into_inner();
            println!("User created: {} ({})", response.username, response.id);
        }
        Some("user list") => {
            let page = cli.page.unwrap_or(1);
            let page_size = cli.page_size.unwrap_or(50);
            let mut client = proto::users::users_client::UsersClient::connect(cli.server).await?;
            let request = Request::new(proto::users::ListUsersRequest { page, page_size });
            let response = client.list_users(request).await?.into_inner();
            println!("Total users: {}", response.total);
            for user in response.users {
                println!(
                    "  {} - {}{}",
                    user.id,
                    user.username,
                    if user.is_admin { " [ADMIN]" } else { "" }
                );
            }
        }
        Some("user update") => {
            let id = cli.id.clone().ok_or("id required")?;
            let username = cli.username.clone();
            let email = cli.email.clone();
            let mut client = proto::users::users_client::UsersClient::connect(cli.server).await?;
            let request = Request::new(proto::users::UpdateUserRequest {
                id,
                username,
                email,
                disabled: None,
            });
            let response = client.update_user(request).await?.into_inner();
            println!("User updated: {} ({})", response.username, response.id);
        }
        Some("user delete") => {
            let id = cli.id.clone().ok_or("id required")?;
            let mut client = proto::users::users_client::UsersClient::connect(cli.server).await?;
            let request = Request::new(proto::users::UpdateUserRequest {
                id: id.clone(),
                username: None,
                email: None,
                disabled: Some(true),
            });
            client.update_user(request).await?.into_inner();
            println!("User disabled: {}", id);
        }
        Some("user set-admin") => {
            let id = cli.id.clone().ok_or("id required")?;
            let yes = cli.yes.unwrap_or(false);
            let mut client = proto::users::users_client::UsersClient::connect(cli.server).await?;
            let request = Request::new(proto::users::SetAdminRequest {
                id: id.clone(),
                is_admin: yes,
            });
            client.set_admin(request).await?.into_inner();
            println!("Admin status updated for: {}", id);
        }
        Some("user init-admin") => {
            let username = cli.username.clone().ok_or("username required")?;
            let email = cli.email.clone().ok_or("email required")?;
            let password = cli.password.clone().ok_or("password required")?;
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect(&db)
                .await?;
            use argon2::{password_hash::SaltString, Argon2, PasswordHasher};
            use rand::rngs::OsRng;
            let salt = SaltString::generate(&mut OsRng);
            let argon2 = Argon2::default();
            let hash = argon2
                .hash_password(password.as_bytes(), &salt)
                .map_err(|e| e.to_string())?
                .to_string();
            let id = uuid::Uuid::new_v4();
            sqlx::query("INSERT INTO users (id, username, email, password_hash, is_admin, created_at, updated_at) VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())")
                .bind(id).bind(&username).bind(&email).bind(&hash).execute(&pool).await?;
            println!("Admin created: {} ({})", username, id);
        }
        Some("db") | Some("db migrate") => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect(&db)
                .await?;
            let migrations_dir = env::var("MIGRATIONS_DIR")
                .map(std::path::PathBuf::from)
                .ok()
                .or_else(|| {
                    std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|parent| parent.join("../migrations")))
                })
                .unwrap_or_else(|| std::path::PathBuf::from("../migrations"));

            let migrations = std::fs::read_dir(&migrations_dir)
                .map_err(|e| format!("Cannot read migrations dir '{}': {}", migrations_dir.display(), e))?
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
        Some("db reset") => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .connect(&db)
                .await?;
            sqlx::query("DROP SCHEMA public CASCADE")
                .execute(&pool)
                .await?;
            sqlx::query("CREATE SCHEMA public").execute(&pool).await?;
            println!("Database reset complete.");
        }
        Some("db status") => {
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
        Some("help") | None => {
            println!("FastChat CLI - Available commands:");
            println!("  user create  --username X --email X --password X");
            println!("  user list    --page N --page-size N");
            println!("  user update  --id X [--username X] [--email X]");
            println!("  user delete  --id X");
            println!("  user set-admin --id X --yes (true/false)");
            println!("  user init-admin --username X --email X --password X");
            println!("  db migrate");
            println!("  db reset");
            println!("  db status");
        }
        _ => {
            println!("Unknown command. Use --help for usage.");
        }
    }
    Ok(())
}
