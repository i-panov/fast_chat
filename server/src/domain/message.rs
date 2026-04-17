//! Domain message entity.

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Message as a domain concept
#[derive(Debug, Clone)]
pub struct Message {
    pub id: Uuid,
    pub chat_id: Option<Uuid>,
    pub sender_id: Option<Uuid>,
    pub encrypted_content: String,
    pub content_type: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl Message {
    pub fn is_edited(&self) -> bool {
        self.edited_at.is_some()
    }

    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn is_text(&self) -> bool {
        self.content_type == "text"
    }
}
