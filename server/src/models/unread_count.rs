use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct UnreadCount {
    pub user_id: Uuid,
    pub chat_id: Uuid,
    pub count: i32,
    pub last_message_at: Option<DateTime<Utc>>,
}
