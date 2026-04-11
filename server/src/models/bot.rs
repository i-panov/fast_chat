use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Bot {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    #[serde(skip_serializing)]
    pub access_token_hash: String,
    pub avatar_url: Option<String>,
    pub webhook_url: Option<String>,
    pub webhook_secret: Option<String>,
    pub delivery_mode: String,
    pub is_active: bool,
    pub is_master: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BotCommand {
    pub id: Uuid,
    pub bot_id: Uuid,
    pub command: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct BotChat {
    pub bot_id: Uuid,
    pub chat_id: Uuid,
    pub created_at: DateTime<Utc>,
}
