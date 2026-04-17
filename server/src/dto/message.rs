//! Message-related DTOs

use serde::{Deserialize, Serialize};

// ============ Requests ============

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub chat_id: String,
    pub content: String,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub file_metadata_id: Option<String>,
    #[serde(default)]
    pub topic_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct GetMessagesQuery {
    #[serde(default)]
    pub limit: Option<i32>,
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub topic_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateThreadRequest {
    pub chat_id: String,
    pub root_message_id: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateTopicRequest {
    pub chat_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct GetTopicsQuery {
    pub chat_id: String,
}

// ============ Responses ============

#[derive(Debug, Serialize, Clone)]
pub struct MessageResponse {
    pub id: String,
    pub chat_id: Option<String>,
    pub channel_id: Option<String>,
    pub sender_id: String,
    pub encrypted_content: String,
    pub content_type: String,
    pub file_metadata_id: Option<String>,
    pub status: String,
    pub edited: bool,
    pub deleted: bool,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub topic_id: Option<String>,
    pub thread_id: Option<String>,
}

impl From<&crate::models::Message> for MessageResponse {
    fn from(msg: &crate::models::Message) -> Self {
        Self {
            id: msg.id.to_string(),
            chat_id: msg.chat_id.map(|id| id.to_string()),
            channel_id: msg.channel_id.map(|id| id.to_string()),
            sender_id: msg
                .sender_id
                .map(|id| id.to_string())
                .or_else(|| msg.bot_sender_id.map(|id| id.to_string()))
                .unwrap_or_default(),
            encrypted_content: msg.encrypted_content.clone(),
            content_type: msg.content_type.clone(),
            file_metadata_id: msg.file_metadata_id.map(|id| id.to_string()),
            status: msg.status.clone(),
            edited: msg.edited_at.is_some(),
            deleted: msg.deleted_at.is_some(),
            created_at: msg.created_at.to_rfc3339(),
            edited_at: msg.edited_at.map(|dt| dt.to_rfc3339()),
            topic_id: msg.topic_id.map(|id| id.to_string()),
            thread_id: msg.thread_id.map(|id| id.to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct MessagesPage {
    pub messages: Vec<MessageResponse>,
    pub has_more: bool,
    pub next_cursor: String,
}

#[derive(Debug, Serialize)]
pub struct ThreadResponse {
    pub id: String,
    pub chat_id: String,
    pub root_message_id: String,
    pub reply_count: i32,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct TopicResponse {
    pub id: String,
    pub chat_id: String,
    pub name: String,
    pub created_at: String,
}
