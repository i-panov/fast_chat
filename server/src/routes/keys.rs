use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    AppState,
};

pub async fn get_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth_header, &state.settings.jwt_secret)
}

#[derive(serde::Deserialize)]
pub struct UploadKeyRequest {
    encrypted_private_key: String,
}

#[derive(serde::Deserialize)]
pub struct RequestSyncRequest {
    device_name: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct ApproveSyncRequest {
    code: String,
    encrypted_private_key: String,
}

#[derive(serde::Deserialize)]
pub struct ConfirmByPasswordRequest {
    password: String,
}

/// Upload encrypted private key to server
/// POST /api/keys/upload
pub async fn upload_key(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<UploadKeyRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    sqlx::query(
        "UPDATE users SET encrypted_private_key = $1 WHERE id = $2",
    )
    .bind(req.encrypted_private_key.as_bytes())
    .bind(user_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({ "success": true })))
}

/// Download encrypted private key from server
/// GET /api/keys/download
pub async fn download_key(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let encrypted_key: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT encrypted_private_key FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(state.db.get_pool())
    .await?;

    match encrypted_key {
        Some(key) if !key.is_empty() => Ok(Json(serde_json::json!({
            "encrypted_private_key": String::from_utf8_lossy(&key)
        }))),
        _ => Err(AppError::NotFound("No encrypted key found".to_string())),
    }
}

/// Request key sync from new device
/// POST /api/keys/request-sync
pub async fn request_sync(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<RequestSyncRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let has_key: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND encrypted_private_key IS NOT NULL AND length(encrypted_private_key) > 0)",
    )
    .bind(user_id)
    .fetch_one(state.db.get_pool())
    .await?;

    if !has_key {
        return Err(AppError::Validation("No encrypted key found on server. Generate a key first.".to_string()));
    }

    let code = generate_sync_code();
    let device_name = req.device_name.unwrap_or_else(|| "New device".to_string());

    sqlx::query(
        "INSERT INTO key_sync_requests (user_id, device_name, code) VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(device_name)
    .bind(&code)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({
        "code_sent": true,
        "message": "Confirmation code sent. Check your email or other authorized device."
    })))
}

/// Approve key sync from first device
/// POST /api/keys/approve-sync
pub async fn approve_sync(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<ApproveSyncRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let request = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, code FROM key_sync_requests WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(state.db.get_pool())
    .await?
    .ok_or_else(|| AppError::Validation("No pending sync request found".to_string()))?;

    let (request_id, expected_code) = request;

    if req.code != expected_code {
        return Err(AppError::InvalidCredentials);
    }

    sqlx::query("UPDATE key_sync_requests SET status = 'approved' WHERE id = $1")
        .bind(request_id)
        .execute(state.db.get_pool())
        .await?;

    sqlx::query("UPDATE users SET encrypted_private_key = $1 WHERE id = $2")
        .bind(req.encrypted_private_key.as_bytes())
        .bind(user_id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Key sync approved. The device now has access to your encrypted messages."
    })))
}

/// Get pending sync requests (for first device to see)
/// GET /api/keys/pending
pub async fn get_pending_syncs(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let requests: Vec<serde_json::Value> = sqlx::query_as::<_, (Uuid, String, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, device_name, created_at, expires_at FROM key_sync_requests WHERE user_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?
    .into_iter()
    .map(|(id, device_name, created_at, expires_at)| {
        serde_json::json!({
            "id": id,
            "device_name": device_name,
            "created_at": created_at,
            "expires_at": expires_at
        })
    })
    .collect();

    Ok(Json(serde_json::Value::Array(requests)))
}

/// Check if user has encrypted key on server
/// GET /api/keys/status
pub async fn get_key_status(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let has_key: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND encrypted_private_key IS NOT NULL AND length(encrypted_private_key) > 0)",
    )
    .bind(user_id)
    .fetch_one(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({
        "has_encrypted_key": has_key
    })))
}

fn generate_sync_code() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen::<u32>() % 900000 + 100000)
}