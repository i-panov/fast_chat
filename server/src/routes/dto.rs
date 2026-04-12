use serde::{Deserialize, Serialize};

// ============ Users ============

#[derive(Debug, Serialize, Clone)]
pub struct UserResponse {
    pub id: String,
    pub username: String,
    pub email: String,
    pub is_admin: bool,
    pub totp_enabled: bool,
    pub created_at: String,
}

impl From<&crate::models::User> for UserResponse {
    fn from(user: &crate::models::User) -> Self {
        Self {
            id: user.id.to_string(),
            username: user.username.clone(),
            email: user.email.clone(),
            is_admin: user.is_admin,
            totp_enabled: user.totp_enabled,
            created_at: user.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub email: Option<String>,
    pub is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub username: Option<String>,
    pub email: Option<String>,
}

// ============ Messaging ============

#[derive(Debug, Serialize, Clone)]
pub struct ChatResponse {
    pub id: String,
    pub is_group: bool,
    pub name: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub is_favorites: bool,
    pub participants: Vec<String>,
}

impl From<&crate::models::Chat> for ChatResponse {
    fn from(chat: &crate::models::Chat) -> Self {
        Self {
            id: chat.id.to_string(),
            is_group: chat.is_group,
            name: chat.name.clone(),
            created_by: chat.created_by.to_string(),
            created_at: chat.created_at.to_rfc3339(),
            is_favorites: chat.is_favorites,
            participants: Vec::new(),
        }
    }
}

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
            sender_id: msg.sender_id.to_string(),
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

#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub is_group: bool,
    pub name: Option<String>,
    pub participants: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub chat_id: String,
    pub content: String,
    pub content_type: Option<String>,
    pub file_metadata_id: Option<String>,
    pub topic_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EditMessageRequest {
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct GetMessagesQuery {
    pub limit: Option<i32>,
    pub cursor: Option<i32>,
    pub topic_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MessagesPage {
    pub messages: Vec<MessageResponse>,
    pub has_more: bool,
    pub next_cursor: String,
}

// ============ Threads & Topics ============

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

// ============ SSE ============

// ============ Common ============

#[derive(Debug, Serialize)]
pub struct Ack {
    pub success: bool,
    pub message: String,
}
