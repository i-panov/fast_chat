use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct File {
    pub id: Uuid,
    pub original_name: String,
    pub stored_path: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
    pub uploader_id: Uuid,
    pub uploaded_at: DateTime<Utc>,
}
