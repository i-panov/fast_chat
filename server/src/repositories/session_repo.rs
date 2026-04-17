//! Session repository — data access for user_sessions table.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

/// Repository for session data access operations
#[derive(Clone)]
pub struct SessionRepository;

impl SessionRepository {
    /// Create a new session
    pub async fn create(
        pool: &PgPool,
        id: Uuid,
        user_id: Uuid,
        refresh_token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)"
        )
        .bind(id)
        .bind(user_id)
        .bind(refresh_token_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Validate refresh token
    pub async fn validate_token(
        pool: &PgPool,
        token_hash: &str,
    ) -> Result<Option<Uuid>, AppError> {
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM user_sessions WHERE refresh_token_hash = $1 AND expires_at > NOW()"
        )
        .bind(token_hash)
        .fetch_optional(pool)
        .await?;
        Ok(user_id)
    }

    /// Delete session by token hash
    pub async fn delete_by_token(pool: &PgPool, token_hash: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM user_sessions WHERE refresh_token_hash = $1")
            .bind(token_hash)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Delete all sessions for user
    pub async fn delete_all_for_user(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
        sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Delete expired sessions
    pub async fn delete_expired(pool: &PgPool) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM user_sessions WHERE expires_at < NOW()")
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}
