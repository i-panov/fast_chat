//! Common DTOs shared across modules

use serde::{Deserialize, Serialize};

// ============ Common ============

#[derive(Debug, Serialize)]
pub struct Ack {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct IdResponse {
    pub id: String,
}

#[derive(Debug, Serialize)]
pub struct ParticipantsResponse {
    pub participants: Vec<String>,
}

// ============ Files ============

#[derive(Debug, Serialize)]
pub struct FileResponse {
    pub id: String,
    pub original_name: String,
    pub mime_type: Option<String>,
    pub size_bytes: i64,
    pub uploaded_at: String,
}

impl From<&crate::models::File> for FileResponse {
    fn from(file: &crate::models::File) -> Self {
        Self {
            id: file.id.to_string(),
            original_name: file.original_name.clone(),
            mime_type: file.mime_type.clone(),
            size_bytes: file.size_bytes,
            uploaded_at: file.uploaded_at.to_rfc3339(),
        }
    }
}

// ============ Signaling ============

#[derive(Debug, Serialize)]
pub struct CallResponse {
    pub id: String,
    pub chat_id: Option<String>,
    pub caller_id: String,
    pub callee_id: Option<String>,
    pub status: String,
    pub started_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateCallRequest {
    pub chat_id: Option<String>,
    pub callee_id: Option<String>,
}

// ============ Query Parameters ============

#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    #[serde(default = "default_page_size")]
    pub limit: i32,
    #[serde(default)]
    pub offset: Option<i32>,
    #[serde(default)]
    pub cursor: Option<String>,
}

fn default_page_size() -> i32 {
    50
}
