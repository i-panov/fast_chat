//! User repository — data access for users table.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::constants;
use crate::error::AppError;
use crate::models::User;

/// Repository for user data access operations
#[derive(Clone)]
pub struct UserRepository;

impl UserRepository {
    /// Find user by ID
    pub async fn find_by_id(pool: &PgPool, id: Uuid) -> Result<Option<User>, AppError> {
        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE id = $1"
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        Ok(user)
    }

    /// Find user by email
    pub async fn find_by_email(pool: &PgPool, email: &str) -> Result<Option<User>, AppError> {
        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE email = $1"
        )
        .bind(email)
        .fetch_optional(pool)
        .await?;
        Ok(user)
    }

    /// Find user by username
    pub async fn find_by_username(pool: &PgPool, username: &str) -> Result<Option<User>, AppError> {
        let user = sqlx::query_as::<_, User>(
            "SELECT * FROM users WHERE username = $1"
        )
        .bind(username)
        .fetch_optional(pool)
        .await?;
        Ok(user)
    }

    /// Create a new user
    pub async fn create(
        pool: &PgPool,
        id: Uuid,
        username: &str,
        email: &str,
        public_key: &str,
        is_admin: bool,
    ) -> Result<User, AppError> {
        let now = Utc::now();
        
        sqlx::query_as::<_, User>(
            r#"
            INSERT INTO users (id, username, email, public_key, is_admin, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (username) DO UPDATE SET email = $3, public_key = $4, updated_at = $7
            RETURNING *
            "#,
        )
        .bind(id)
        .bind(username)
        .bind(email)
        .bind(public_key)
        .bind(is_admin)
        .bind(now)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
    }

    /// Create user or get existing by email (for registration)
    pub async fn find_or_create(
        pool: &PgPool,
        id: Uuid,
        username: &str,
        email: &str,
        public_key: &str,
    ) -> Result<User, AppError> {
        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO users (id, username, email, public_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (email) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(username)
        .bind(email)
        .bind(public_key)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        Self::find_by_email(pool, email)
            .await?
            .ok_or(AppError::UserNotFound)
    }

    /// Update user's public key
    pub async fn update_public_key(
        pool: &PgPool,
        user_id: Uuid,
        public_key: &str,
    ) -> Result<(), AppError> {
        sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
            .bind(public_key)
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Update user's TOTP settings
    pub async fn update_totp(
        pool: &PgPool,
        user_id: Uuid,
        totp_secret: Option<&str>,
        totp_enabled: bool,
        backup_codes_encrypted: Option<&str>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE users SET totp_secret = $1, totp_enabled = $2, backup_codes_encrypted = $3 WHERE id = $4"
        )
        .bind(totp_secret)
        .bind(totp_enabled)
        .bind(backup_codes_encrypted)
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Disable user's TOTP
    pub async fn disable_totp(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, backup_codes_encrypted = NULL WHERE id = $1"
        )
        .bind(user_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Set admin status
    pub async fn set_admin(pool: &PgPool, user_id: Uuid, is_admin: bool) -> Result<(), AppError> {
        sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
            .bind(is_admin)
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Set disabled status
    pub async fn set_disabled(pool: &PgPool, user_id: Uuid, disabled: bool) -> Result<(), AppError> {
        sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
            .bind(disabled)
            .bind(user_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// List all users
    pub async fn list_all(pool: &PgPool) -> Result<Vec<User>, AppError> {
        let users = sqlx::query_as::<_, User>(
            "SELECT * FROM users ORDER BY created_at DESC"
        )
        .fetch_all(pool)
        .await?;
        Ok(users)
    }

    /// Search users by username or email
    pub async fn search(pool: &PgPool, query: &str, limit: i32) -> Result<Vec<User>, AppError> {
        let search_pattern = format!("%{}%", query);
        let users = sqlx::query_as::<_, User>(
            r#"
            SELECT * FROM users 
            WHERE username ILIKE $1 OR email ILIKE $1
            ORDER BY created_at DESC
            LIMIT $2
            "#
        )
        .bind(&search_pattern)
        .bind(limit)
        .fetch_all(pool)
        .await?;
        Ok(users)
    }

    /// Check if user exists by email
    pub async fn exists_by_email(pool: &PgPool, email: &str) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)"
        )
        .bind(email)
        .fetch_one(pool)
        .await?;
        Ok(exists)
    }

    /// Get user 2FA status (admin and totp_enabled)
    pub async fn get_2fa_status(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Option<(bool, bool)>, AppError> {
        let row: Option<(bool, bool)> = sqlx::query_as(
            "SELECT is_admin, COALESCE(totp_enabled, FALSE) FROM users WHERE id = $1"
        )
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
        Ok(row)
    }
}
