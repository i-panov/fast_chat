use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub public_key: Option<String>,
    pub is_admin: bool,
    pub disabled: bool,
    pub totp_secret: Option<String>,
    pub totp_enabled: bool,
    pub backup_codes_encrypted: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct UserPublic {
    pub id: Uuid,
    pub username: String,
    pub public_key: Option<String>,
    pub is_admin: bool,
    pub totp_enabled: bool,
    pub created_at: DateTime<Utc>,
}

impl From<User> for UserPublic {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            public_key: user.public_key,
            is_admin: user.is_admin,
            totp_enabled: user.totp_enabled,
            created_at: user.created_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ContentType {
    #[default]
    Text,
    File,
    Image,
}

impl std::fmt::Display for ContentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContentType::Text => write!(f, "text"),
            ContentType::File => write!(f, "file"),
            ContentType::Image => write!(f, "image"),
        }
    }
}

impl std::str::FromStr for ContentType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "text" => Ok(ContentType::Text),
            "file" => Ok(ContentType::File),
            "image" => Ok(ContentType::Image),
            _ => Err(format!("Unknown content type: {}", s)),
        }
    }
}
