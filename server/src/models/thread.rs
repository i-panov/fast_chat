use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Thread {
    pub id: Uuid,
    pub chat_id: Uuid,
    pub root_message_id: Uuid,
    pub created_at: DateTime<Utc>,
}
