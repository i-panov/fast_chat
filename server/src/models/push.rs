use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PushSubscription {
    pub id: Uuid,
    pub user_id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth_secret: String,
    pub user_agent: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct NotificationSettings {
    pub user_id: Uuid,
    pub push_enabled: bool,
    pub sound_enabled: bool,
    pub preview_enabled: bool,
    pub mute_all: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MutedChat {
    pub user_id: Uuid,
    pub chat_id: Option<Uuid>,
    pub channel_id: Option<Uuid>,
    pub muted_until: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}
