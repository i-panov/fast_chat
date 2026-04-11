use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "fast-chat-server")]
#[command(about = "Fast Chat Server", long_about = None)]
pub struct Cli {
    #[arg(short, long, default_value = "0.0.0.0:50051")]
    pub addr: String,

    #[arg(long, env = "DATABASE_URL")]
    pub database_url: Option<String>,

    #[arg(long, env = "REDIS_URL")]
    pub redis_url: Option<String>,

    #[arg(long, env = "JWT_SECRET")]
    pub jwt_secret: Option<String>,

    #[arg(long, env = "FILES_DIR")]
    pub files_dir: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Create a new user (admin only)
    UserCreate {
        #[arg(short, long)]
        username: String,

        #[arg(short, long)]
        email: String,

        #[arg(long, default_value = "false")]
        admin: bool,
    },

    /// List all users
    UserList,

    /// Set user as admin
    UserSetAdmin {
        #[arg(short, long)]
        id: String,

        #[arg(long, default_value = "true")]
        yes: bool,
    },

    /// Enable/disable user
    UserSetDisabled {
        #[arg(short, long)]
        id: String,

        #[arg(long)]
        yes: bool,
    },

    /// Run database migrations
    Migrate,

    /// Reset database (dangerous!)
    DbReset {
        #[arg(long, default_value = "false")]
        force: bool,
    },
}

impl Cli {
    pub fn database_url(&self) -> String {
        self.database_url
            .clone()
            .unwrap_or_else(|| "postgres://fast_chat:changeme@localhost:5432/fast_chat".to_string())
    }

    pub fn redis_url(&self) -> String {
        self.redis_url
            .clone()
            .unwrap_or_else(|| "redis://localhost:6379".to_string())
    }

    pub fn jwt_secret(&self) -> Result<String, String> {
        self.jwt_secret.clone().ok_or_else(|| {
            "JWT_SECRET is not set! You MUST provide a JWT secret via --jwt-secret or the JWT_SECRET environment variable.\n\
             For development, you can use: JWT_SECRET=dev-secret-key-32chars!"
                .to_string()
        })
    }

    pub fn files_dir(&self) -> PathBuf {
        self.files_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("./files"))
    }
}
