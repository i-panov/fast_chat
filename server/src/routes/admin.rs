use axum::{
    extract::{Path, State},
    http::{HeaderMap, header::AUTHORIZATION},
    Json,
};
use chrono::Utc;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    AppState,
};

pub fn router(state: std::sync::Arc<AppState>) -> axum::Router<std::sync::Arc<AppState>> {
    axum::Router::new()
        .route("/health", axum::routing::get(health_check))
        .route("/settings", axum::routing::get(get_settings))
        .route("/settings", axum::routing::put(update_settings))
        .route("/settings/:key", axum::routing::put(update_setting_key))
        .with_state(state)
}

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

async fn get_setting_async(state: &AppState, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM server_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(state.db.get_pool())
        .await
        .ok()
        .flatten()
}

/// GET /api/admin/settings
pub async fn get_settings(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = require_admin(&state, &headers).await?;

    let allow_registration = get_setting_async(&state, "allow_registration").await.unwrap_or_else(|| {
        if state.settings.allow_registration { "true".to_string() } else { "false".to_string() }
    }) == "true";

    let require_2fa = get_setting_async(&state, "require_2fa").await.unwrap_or_else(|| {
        if state.settings.require_2fa { "true".to_string() } else { "false".to_string() }
    }) == "true";

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
    let user_id = require_admin(&state, &headers).await?;
    let now = Utc::now();

    if let Some(val) = body.get("allow_registration").and_then(|v| v.as_bool()) {
        let val_str = if val { "true" } else { "false" };
        sqlx::query(
            "INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3) \
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3",
        )
        .bind("allow_registration")
        .bind(val_str)
        .bind(now)
        .execute(state.db.get_pool())
        .await?;
    }

    if let Some(val) = body.get("require_2fa").and_then(|v| v.as_bool()) {
        let val_str = if val { "true" } else { "false" };
        sqlx::query(
            "INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3) \
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3",
        )
        .bind("require_2fa")
        .bind(val_str)
        .bind(now)
        .execute(state.db.get_pool())
        .await?;
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

    let val = body.get("value").and_then(|v| v.as_bool())
        .ok_or_else(|| AppError::Validation("value (boolean) is required".to_string()))?;

    let valid_keys = &["allow_registration", "require_2fa"];
    if !valid_keys.contains(&key.as_str()) {
        return Err(AppError::Validation(format!("Unknown setting: {}. Valid keys: {:?}", key, valid_keys)));
    }

    let val_str = if val { "true" } else { "false" };
    let now = Utc::now();

    sqlx::query(
        "INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, $3) \
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3",
    )
    .bind(&key)
    .bind(val_str)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

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

    let is_admin: bool = sqlx::query_scalar("SELECT is_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .unwrap_or(false);

    if !is_admin {
        return Err(AppError::NotAuthorized);
    }

    // Admins must have TOTP enabled
    let totp_enabled: bool = sqlx::query_scalar("SELECT totp_enabled FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .unwrap_or(false);

    if !totp_enabled {
        return Err(AppError::Validation("Admin must have 2FA enabled".to_string()));
    }

    Ok(user_id)
}
