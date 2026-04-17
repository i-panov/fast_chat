//! Message repository — data access for messages table.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::Message;

/// Repository for message data access operations
#[derive(Clone)]
pub struct MessageRepository;

impl MessageRepository {
    /// Find message by ID
    pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<Message>, AppError> {
        let message = sqlx::query_as::<_, Message>(
            "SELECT * FROM messages WHERE id = $1"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(message)
    }

    /// Create a new message
    pub async fn create(
        pool: &PgPool,
        id: Uuid,
        chat_id: Option<Uuid>,
        sender_id: Option<Uuid>,
        encrypted_content: &str,
        content_type: &str,
    ) -> Result<Message, AppError> {
        let now = Utc::now();
        
        let message = sqlx::query_as::<_, Message>(
            r#"
            INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#
        )
        .bind(id)
        .bind(chat_id)
        .bind(sender_id)
        .bind(encrypted_content)
        .bind(content_type)
        .bind(now)
        .fetch_one(pool)
        .await?;
        Ok(message)
    }

    /// Get messages for a chat (paginated)
    pub async fn get_chat_messages(
        pool: &PgPool,
        chat_id: Uuid,
        limit: i32,
        cursor: Option<i32>,
        topic_id: Option<Uuid>,
    ) -> Result<(Vec<Message>, bool, i32), AppError> {
        let limit = limit + 1; // Fetch one extra to check if there are more
        
        let query = if cursor.is_some() {
            if topic_id.is_some() {
                sqlx::query_as::<_, Message>(
                    r#"
                    SELECT * FROM messages
                    WHERE chat_id = $1 AND topic_id = $2 AND created_at < (
                        SELECT created_at FROM messages WHERE id = $3
                    )
                    ORDER BY created_at DESC
                    LIMIT $4
                    "#
                )
                .bind(chat_id)
                .bind(topic_id)
                .bind(cursor)
                .bind(limit)
            } else {
                sqlx::query_as::<_, Message>(
                    r#"
                    SELECT * FROM messages
                    WHERE chat_id = $1 AND created_at < (
                        SELECT created_at FROM messages WHERE id = $2
                    )
                    ORDER BY created_at DESC
                    LIMIT $3
                    "#
                )
                .bind(chat_id)
                .bind(cursor)
                .bind(limit)
            }
        } else if topic_id.is_some() {
            sqlx::query_as::<_, Message>(
                r#"
                SELECT * FROM messages
                WHERE chat_id = $1 AND topic_id = $2
                ORDER BY created_at DESC
                LIMIT $3
                "#
            )
            .bind(chat_id)
            .bind(topic_id)
            .bind(limit)
        } else {
            sqlx::query_as::<_, Message>(
                r#"
                SELECT * FROM messages
                WHERE chat_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                "#
            )
            .bind(chat_id)
            .bind(limit)
        };

        let messages = query.fetch_all(pool).await?;
        
        let has_more = messages.len() as i32 > limit - 1;
        let messages: Vec<Message> = messages.into_iter().take(limit as usize - 1).collect();
        let next_cursor = messages.last().map(|m| m.id.to_string()).unwrap_or_default();

        Ok((messages, has_more, 0))
    }

    /// Edit message content
    pub async fn update_content(
        pool: &PgPool,
        message_id: Uuid,
        encrypted_content: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE messages SET encrypted_content = $1, edited_at = NOW() WHERE id = $2"
        )
        .bind(encrypted_content)
        .bind(message_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Soft delete message
    pub async fn soft_delete(pool: &PgPool, message_id: Uuid) -> Result<(), AppError> {
        sqlx::query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
            .bind(message_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Get message sender username
    pub async fn get_sender_username(pool: &PgPool, sender_id: Uuid) -> Result<Option<String>, AppError> {
        let username: Option<String> = sqlx::query_scalar(
            "SELECT username FROM users WHERE id = $1"
        )
        .bind(sender_id)
        .fetch_optional(pool)
        .await?;
        Ok(username)
    }
}
