use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// User information
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "User")]
    pub type User;
}

/// Chat information
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Chat")]
    pub type Chat;
}

/// Message in a chat
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Message")]
    pub type Message;
}

/// Authentication response
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "AuthResponse")]
    pub type AuthResponse;
}

// Rust types for internal use

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtoUser {
    pub id: String,
    pub username: String,
    pub is_admin: bool,
    pub totp_enabled: bool,
    pub require_2fa: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProtoChat {
    pub id: String,
    pub is_group: bool,
    pub name: String,
    pub participants: Vec<String>,
    pub created_at: String,
    pub created_by: String,
    pub is_favorites: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProtoMessage {
    pub id: String,
    pub chat_id: String,
    pub sender_id: String,
    pub encrypted_content: String,
    pub content_type: String,
    pub file_metadata_id: String,
    pub status: String,
    pub edited: bool,
    pub deleted: bool,
    pub created_at: String,
    pub edited_at: String,
    pub topic_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UnreadCount {
    pub chat_id: String,
    pub count: i32,
    pub last_message_at: String,
}
