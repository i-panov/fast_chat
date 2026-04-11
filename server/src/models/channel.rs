use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Channel {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    pub username: Option<String>,
    pub access_level: String,
    pub avatar_url: Option<String>,
    pub subscribers_count: i32,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ChannelSubscriber {
    pub channel_id: Uuid,
    pub user_id: Uuid,
    pub status: String,
    pub joined_at: DateTime<Utc>,
}
