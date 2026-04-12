use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use super::user::ContentType;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Message {
    pub id: Uuid,
    pub chat_id: Option<Uuid>,
    pub channel_id: Option<Uuid>,
    pub sender_id: Uuid,
    pub encrypted_content: String,
    pub content_type: String,
    pub file_metadata_id: Option<Uuid>,
    pub status: String,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub topic_id: Option<Uuid>,
    pub thread_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

impl Message {
    #[allow(dead_code)]
    pub fn content_type_enum(&self) -> ContentType {
        self.content_type.parse().unwrap_or_default()
    }
}
