//! Settings repository — data access for server_settings table.

use sqlx::PgPool;

use crate::constants;
use crate::error::AppError;

/// Repository for server settings
#[derive(Clone)]
pub struct SettingsRepository;

impl SettingsRepository {
    /// Get a setting value
    pub async fn get(pool: &PgPool, key: &str) -> Result<Option<String>, AppError> {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT value FROM server_settings WHERE key = $1"
        )
        .bind(key)
        .fetch_optional(pool)
        .await?;
        Ok(value)
    }

    /// Set a setting value
    pub async fn set(pool: &PgPool, key: &str, value: &str) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()"
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Get require_2fa setting (with fallback)
    pub async fn get_require_2fa(pool: &PgPool, default: bool) -> Result<bool, AppError> {
        let value = Self::get(pool, constants::SETTINGS_KEY_REQUIRE_2FA).await?;
        Ok(value.as_deref() == Some("true") || (value.is_none() && default))
    }

    /// Get allow_registration setting (with fallback)
    pub async fn get_allow_registration(pool: &PgPool, default: bool) -> Result<bool, AppError> {
        let value = Self::get(pool, constants::SETTINGS_KEY_ALLOW_REGISTRATION).await?;
        Ok(value.as_deref() == Some("true") || (value.is_none() && default))
    }

    /// Get all settings
    pub async fn get_all(pool: &PgPool) -> Result<Vec<(String, String)>, AppError> {
        let settings: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value FROM server_settings"
        )
        .fetch_all(pool)
        .await?;
        Ok(settings)
    }
}
