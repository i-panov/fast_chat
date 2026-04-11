use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Chat {
    pub id: Uuid,
    pub is_group: bool,
    pub name: Option<String>,
    pub created_by: Uuid,
    pub is_favorites: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ChatWithParticipants {
    pub chat: Chat,
    pub participants: Vec<Uuid>,
}
