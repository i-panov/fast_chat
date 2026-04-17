//! Chat service — business logic for chat operations.

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use crate::dto::chat::{ChatResponse, CreateChatRequest};
use crate::error::AppError;
use crate::models::Chat;
use crate::repositories::ChatRepository;

/// Chat service handles all chat-related business logic
#[derive(Clone)]
pub struct ChatService;

impl ChatService {
    /// Create a new chat or return existing direct chat
    pub async fn create_or_get_chat(
        pool: &PgPool,
        creator_id: Uuid,
        request: &CreateChatRequest,
    ) -> Result<ChatResponse, AppError> {
        // For direct chats, check if chat already exists
        if !request.is_group && request.participants.len() == 1 {
            if let Some(other_id) = Uuid::parse_str(&request.participants[0]).ok() {
                if let Some(chat) = ChatRepository::find_direct_chat(pool, creator_id, other_id).await? {
                    let participants = ChatRepository::get_participant_ids(pool, chat.id).await?;
                    return Ok(ChatResponse::from(&chat).with_participants(participants));
                }
            }
        }

        // Parse participant IDs
        let participant_ids: Vec<Uuid> = request
            .participants
            .iter()
            .filter_map(|p| Uuid::parse_str(p).ok())
            .collect();

        if participant_ids.is_empty() && !request.participants.is_empty() {
            return Err(AppError::Validation("Invalid participant UUID".to_string()));
        }

        // Create chat with participants in transaction
        let chat = ChatRepository::create_with_participants(
            pool,
            Uuid::new_v4(),
            request.is_group,
            request.name.as_deref(),
            creator_id,
            &participant_ids,
        )
        .await?;

        let participants = ChatRepository::get_participant_ids(pool, chat.id).await?;

        Ok(ChatResponse::from(&chat).with_participants(participants))
    }

    /// Get user's chats with participants
    pub async fn get_user_chats(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Vec<ChatResponse>, AppError> {
        let chats = ChatRepository::get_user_chats(pool, user_id).await?;
        let mut result = Vec::with_capacity(chats.len());

        for chat in &chats {
            let participants = ChatRepository::get_participant_ids(pool, chat.id).await?;
            let mut resp = ChatResponse::from(chat);

            // For direct chats, show other user's name
            if !chat.is_group && participants.len() == 2 {
                let other_user_id = participants.iter()
                    .find(|p| p.as_str() != user_id.to_string())
                    .and_then(|p| Uuid::parse_str(p).ok());

                if let Some(other_id) = other_user_id {
                    if let Some(username) = ChatRepository::get_participant_ids(pool, other_id).await?
                        .first()
                        .cloned()
                    {
                        resp.name = Some(username);
                    }
                }
            }

            resp.participants = participants;
            result.push(resp);
        }

        Ok(result)
    }

    /// Get chat by ID with participant verification
    pub async fn get_chat_with_access(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
    ) -> Result<Chat, AppError> {
        let chat = ChatRepository::find_by_id(pool, chat_id)
            .await?
            .ok_or(AppError::ChatNotFound)?;

        let is_participant = ChatRepository::is_participant(pool, chat_id, user_id).await?;
        if !is_participant {
            return Err(AppError::NotAuthorized);
        }

        Ok(chat)
    }
}
