//! Chat-related DTOs

use serde::{Deserialize, Serialize};

use super::common::ParticipantsResponse;

// ============ Requests ============

#[derive(Debug, Deserialize)]
pub struct CreateChatRequest {
    pub is_group: bool,
    pub name: Option<String>,
    pub participants: Vec<String>,
}

// ============ Responses ============

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

impl ChatResponse {
    pub fn with_participants(mut self, participants: Vec<String>) -> Self {
        self.participants = participants;
        self
    }
}

#[derive(Debug, Serialize)]
pub struct ChatsListResponse {
    pub chats: Vec<ChatResponse>,
}
