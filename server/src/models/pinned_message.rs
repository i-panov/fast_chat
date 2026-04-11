use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PinnedMessage {
    pub id: Uuid,
    pub message_id: Uuid,
    pub user_id: Option<Uuid>,
    pub chat_id: Uuid,
    pub created_at: DateTime<Utc>,
}
