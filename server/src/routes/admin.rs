use axum::{
    extract::{Path, State},
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};

use crate::constants;
use crate::error::AppError;
use crate::middleware::jwt::get_user_id_from_request;
use crate::repositories::SettingsRepository;
use crate::AppState;

/// GET /api/admin/health
pub async fn health_check(
    State(state): State<std::sync::Arc<AppState>>,
) -> Json<serde_json::Value> {
    let db_healthy = sqlx::query("SELECT 1")
        .fetch_one(state.db.get_pool())
        .await
        .is_ok();

    Json(serde_json::json!({
        "status": if db_healthy { "ok" } else { "degraded" },
        "database": if db_healthy { "connected" } else { "disconnected" },
    }))
}

/// GET /api/admin/settings
pub async fn get_settings(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = require_admin(&state, &headers).await?;

    let pool = state.db.get_pool();
    let allow_registration = SettingsRepository::get_allow_registration(pool, state.settings.allow_registration)
        .await?;
    let require_2fa = SettingsRepository::get_require_2fa(pool, state.settings.require_2fa)
        .await?;

    Ok(Json(serde_json::json!({
        "allow_registration": allow_registration,
        "require_2fa": require_2fa,
        "updated_by": user_id.to_string(),
    })))
}

/// PUT /api/admin/settings — update multiple settings at once
pub async fn update_settings(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _user_id = require_admin(&state, &headers).await?;
    let pool = state.db.get_pool();

    let mut changed = false;
    let mut new_require_2fa = state.settings.require_2fa;
    let mut new_allow_registration = state.settings.allow_registration;

    if let Some(val) = body.get("allow_registration").and_then(|v| v.as_bool()) {
        let val_str = if val { "true" } else { "false" };
        SettingsRepository::set(pool, constants::SETTINGS_KEY_ALLOW_REGISTRATION, val_str).await?;
        new_allow_registration = val;
        changed = true;
    }

    if let Some(val) = body.get("require_2fa").and_then(|v| v.as_bool()) {
        let val_str = if val { "true" } else { "false" };
        SettingsRepository::set(pool, constants::SETTINGS_KEY_REQUIRE_2FA, val_str).await?;
        new_require_2fa = val;
        changed = true;
    }

    // Refresh cache if settings changed
    if changed {
        let mut cache = state.settings_cache.write().unwrap();
        cache.refresh(new_require_2fa, new_allow_registration);
    }

    get_settings(State(state), headers).await
}

/// PUT /api/admin/settings/:key
pub async fn update_setting_key(
    State(state): State<std::sync::Arc<AppState>>,
    Path(key): Path<String>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    require_admin(&state, &headers).await?;

    let val = body
        .get("value")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| AppError::Validation("value (boolean) is required".to_string()))?;

    let valid_keys = &[constants::SETTINGS_KEY_ALLOW_REGISTRATION, constants::SETTINGS_KEY_REQUIRE_2FA];
    if !valid_keys.contains(&key.as_str()) {
        return Err(AppError::Validation(format!(
            "Unknown setting: {}. Valid keys: {:?}",
            key, valid_keys
        )));
    }

    let pool = state.db.get_pool();
    let val_str = if val { "true" } else { "false" };
    SettingsRepository::set(pool, &key, val_str).await?;

    // Refresh cache
    {
        let mut cache = state.settings_cache.write().unwrap();
        match key.as_str() {
            constants::SETTINGS_KEY_REQUIRE_2FA => cache.require_2fa = val,
            constants::SETTINGS_KEY_ALLOW_REGISTRATION => cache.allow_registration = val,
            _ => {}
        }
    }

    Ok(Json(serde_json::json!({
        "key": key,
        "value": val,
    })))
}

async fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<uuid::Uuid, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;

    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    // Admins must have TOTP enabled
    let (is_admin, totp_enabled): (bool, bool) = sqlx::query_as(
        "SELECT is_admin, COALESCE(totp_enabled, FALSE) FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(state.db.get_pool())
    .await?
    .unwrap_or((false, false));

    if !is_admin {
        return Err(AppError::NotAuthorized);
    }

    if !totp_enabled {
        return Err(AppError::Validation(
            "Admin must have 2FA enabled".to_string(),
        ));
    }

    Ok(user_id)
}
