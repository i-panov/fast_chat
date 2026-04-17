//! Chat repository — data access for chats table.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::Chat;

/// Repository for chat data access operations
#[derive(Clone)]
pub struct ChatRepository;

impl ChatRepository {
    /// Find chat by ID
    pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Chat>, AppError> {
        let chat = sqlx::query_as::<_, Chat>(
            "SELECT * FROM chats WHERE id = $1"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(chat)
    }

    /// Create a new chat
    pub async fn create(
        pool: &PgPool,
        id: Uuid,
        is_group: bool,
        name: Option<&str>,
        created_by: Uuid,
    ) -> Result<Chat, AppError> {
        let now = Utc::now();
        
        let chat = sqlx::query_as::<_, Chat>(
            r#"
            INSERT INTO chats (id, is_group, name, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            "#
        )
        .bind(id)
        .bind(is_group)
        .bind(name)
        .bind(created_by)
        .bind(now)
        .fetch_one(pool)
        .await?;
        Ok(chat)
    }

    /// Add participant to chat
    pub async fn add_participant(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
        )
        .bind(chat_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Remove participant from chat
    pub async fn remove_participant(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), AppError> {
        sqlx::query(
            "DELETE FROM chat_participants WHERE chat_id = $1 AND user_id = $2"
        )
        .bind(chat_id)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Get chat participants
    pub async fn get_participants(pool: &PgPool, chat_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let participants: Vec<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM chat_participants WHERE chat_id = $1"
        )
        .bind(chat_id)
        .fetch_all(pool)
        .await?;
        Ok(participants)
    }

    /// Get chat participants as strings
    pub async fn get_participant_ids(pool: &PgPool, chat_id: Uuid) -> Result<Vec<String>, AppError> {
        let participants: Vec<String> = sqlx::query_scalar(
            "SELECT user_id::text FROM chat_participants WHERE chat_id = $1"
        )
        .bind(chat_id)
        .fetch_all(pool)
        .await?;
        Ok(participants)
    }

    /// Check if user is participant
    pub async fn is_participant(
        pool: &PgPool,
        chat_id: Uuid,
        user_id: Uuid,
    ) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2)"
        )
        .bind(chat_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    /// Find direct chat between two users
    pub async fn find_direct_chat(
        pool: &PgPool,
        user_id_1: Uuid,
        user_id_2: Uuid,
    ) -> Result<Option<Chat>, AppError> {
        let chat = sqlx::query_as::<_, Chat>(
            r#"
            SELECT c.* FROM chats c
            INNER JOIN chat_participants p1 ON p1.chat_id = c.id AND p1.user_id = $1
            INNER JOIN chat_participants p2 ON p2.chat_id = c.id AND p2.user_id = $2
            WHERE c.is_group = FALSE
            LIMIT 1
            "#
        )
        .bind(user_id_1)
        .bind(user_id_2)
        .fetch_optional(pool)
        .await?;
        Ok(chat)
    }

    /// Get user's chats (excluding hidden)
    pub async fn get_user_chats(pool: &PgPool, user_id: Uuid) -> Result<Vec<Chat>, AppError> {
        let chats = sqlx::query_as::<_, Chat>(
            r#"
            SELECT c.* FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            LEFT JOIN hidden_chats hc ON c.id = hc.chat_id AND hc.user_id = $1
            WHERE cp.user_id = $1 AND hc.user_id IS NULL
            ORDER BY c.created_at DESC
            "#
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;
        Ok(chats)
    }

    /// Create chat with participants in a transaction
    pub async fn create_with_participants(
        pool: &PgPool,
        id: Uuid,
        is_group: bool,
        name: Option<&str>,
        created_by: Uuid,
        participant_ids: &[Uuid],
    ) -> Result<Chat, AppError> {
        let mut tx = pool.begin().await?;
        let now = Utc::now();

        let chat = sqlx::query_as::<_, Chat>(
            r#"
            INSERT INTO chats (id, is_group, name, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            "#
        )
        .bind(id)
        .bind(is_group)
        .bind(name)
        .bind(created_by)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;

        // Add creator as participant
        sqlx::query(
            "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)"
        )
        .bind(id)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;

        // Add other participants
        for participant_id in participant_ids {
            sqlx::query(
                "INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
            )
            .bind(id)
            .bind(participant_id)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(chat)
    }
}
