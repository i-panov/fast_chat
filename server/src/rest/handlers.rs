use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::sync::Arc;
use std::time::Instant;

use crate::AppState;
use crate::crypto::CryptoService;

// Shared state for tracking server start time
lazy_static::lazy_static! {
    static ref START_TIME: Instant = Instant::now();
}

// --- Request/Response types ---

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    pub totp_code: Option<String>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: UserResponse,
}

#[derive(Deserialize)]
pub struct ListUsersQuery {
    page: Option<i32>,
    page_size: Option<i32>,
}

#[derive(Serialize)]
pub struct UserResponse {
    pub id: String,
    pub username: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub totp_enabled: bool,
    pub public_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub is_admin: bool,
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    pub username: Option<String>,
    pub disabled: Option<bool>,
}

#[derive(Deserialize)]
pub struct SetAdminRequest {
    pub is_admin: bool,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_seconds: u64,
    pub active_calls: i32,
}

#[derive(Serialize)]
pub struct StatsResponse {
    pub total_users: i64,
    pub total_chats: i64,
    pub total_messages: i64,
    pub active_calls: i32,
    pub uptime_seconds: u64,
}

// --- Handlers ---

pub async fn health(
    State(_state): State<Arc<AppState>>,
) -> Json<HealthResponse> {
    let active_calls = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM active_calls WHERE status = 'active'",
    )
    .fetch_one(_state.db.get_pool())
    .await
    .unwrap_or(0);

    Json(HealthResponse {
        status: "healthy".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: START_TIME.elapsed().as_secs(),
        active_calls: active_calls as i32,
    })
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, StatusCode> {
    use chrono::{Duration, Utc};
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    use sha2::{Digest, Sha256};

    // Fetch user by username
    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE username = $1")
        .bind(&req.username)
        .fetch_optional(state.db.get_pool())
        .await
        .map_err(|e| {
            tracing::error!("DB error in login: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let user = match user {
        Some(u) => u,
        None => {
            tracing::warn!("Login attempt for unknown username: {}", req.username);
            return Err(StatusCode::UNAUTHORIZED);
        }
    };

    tracing::info!("Login attempt: username={}, disabled={}, totp={}", req.username, user.disabled, user.totp_enabled);

    // Check if user is disabled
    if user.disabled {
        tracing::warn!("Login denied: user {} is disabled", req.username);
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Verify password
    let password_valid = match CryptoService::verify_password(&req.password, &user.password_hash) {
        Ok(valid) => {
            tracing::info!("Password check for {}: {}", req.username, valid);
            valid
        }
        Err(e) => {
            tracing::error!("Password verification error for {}: {:?}", req.username, e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    if !password_valid {
        tracing::warn!("Login denied: invalid password for {}", req.username);
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Check 2FA if enabled
    if user.totp_enabled {
        let totp_code = req.totp_code.as_deref().unwrap_or("");
        if totp_code.is_empty() {
            // Need 2FA code — return 403 to signal client to ask for it
            let mut resp = axum::response::Response::new(
                axum::body::Body::from("2FA_REQUIRED")
            );
            *resp.status_mut() = StatusCode::from_u16(403).unwrap();
            return Err(StatusCode::from_u16(403).unwrap());
        }

        if let Some(ref encrypted_secret) = user.totp_secret {
            let decrypted = CryptoService::decrypt_aes(encrypted_secret, &state.settings.jwt_secret)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let secret_b64 = String::from_utf8(decrypted)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

            let valid = verify_totp(&secret_b64, totp_code);
            if !valid {
                // Try backup codes
                let backup_valid = user.backup_codes_encrypted.as_deref()
                    .map(|enc| {
                        CryptoService::decrypt_aes(enc, &state.settings.jwt_secret)
                            .ok()
                            .and_then(|dec| String::from_utf8(dec).ok())
                            .and_then(|json_str| {
                                serde_json::from_str::<Vec<String>>(&json_str).ok()
                            })
                            .map(|hashes| {
                                hashes.iter().any(|h| {
                                    CryptoService::verify_backup_code(totp_code, h).unwrap_or(false)
                                })
                            })
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);

                if !backup_valid {
                    return Err(StatusCode::UNAUTHORIZED);
                }
            }
        } else {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    // Generate tokens
    let now = Utc::now();
    let expiry = now + Duration::hours(state.settings.jwt_expiry_hours);

    #[derive(Serialize)]
    struct Claims {
        sub: String,
        exp: i64,
        iat: i64,
    }

    let access_claims = Claims {
        sub: user.id.to_string(),
        exp: expiry.timestamp(),
        iat: now.timestamp(),
    };

    let key = EncodingKey::from_secret(state.settings.jwt_secret.as_bytes());
    let access_token = encode(&Header::new(Algorithm::HS256), &access_claims, &key)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let refresh_expiry = now + Duration::days(7);
    let refresh_claims = Claims {
        sub: user.id.to_string(),
        exp: refresh_expiry.timestamp(),
        iat: now.timestamp(),
    };

    let refresh_token = encode(&Header::new(Algorithm::HS256), &refresh_claims, &key)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Store refresh token session
    let token_hash = BASE64.encode(Sha256::digest(refresh_token.as_bytes()));
    let session_id = Uuid::new_v4();
    let _ = sqlx::query(
        "INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(session_id)
    .bind(user.id)
    .bind(&token_hash)
    .bind(refresh_expiry.naive_utc())
    .execute(state.db.get_pool())
    .await;

    let user_resp = UserResponse {
        id: user.id.to_string(),
        username: user.username,
        is_admin: user.is_admin,
        disabled: user.disabled,
        totp_enabled: user.totp_enabled,
        public_key: user.public_key,
        created_at: user.created_at.to_rfc3339(),
        updated_at: user.updated_at.to_rfc3339(),
    };

    Ok(Json(LoginResponse {
        access_token,
        refresh_token,
        user: user_resp,
    }))
}

fn verify_totp(secret_b64: &str, code: &str) -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};
    use totp_lite::{totp, Sha1};

    let secret_bytes = match BASE64.decode(secret_b64) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    let expected = totp::<Sha1>(&secret_bytes, seconds);

    expected == code
}

pub async fn list_users(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListUsersQuery>,
) -> Result<Json<Vec<UserResponse>>, StatusCode> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * page_size;

    let users = sqlx::query_as::<_, crate::models::User>(
        "SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    )
    .bind(page_size)
    .bind(offset)
    .fetch_all(state.db.get_pool())
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let response: Vec<UserResponse> = users
        .into_iter()
        .map(|u| UserResponse {
            id: u.id.to_string(),
            username: u.username,
            is_admin: u.is_admin,
            disabled: u.disabled,
            totp_enabled: u.totp_enabled,
            public_key: u.public_key,
            created_at: u.created_at.to_rfc3339(),
            updated_at: u.updated_at.to_rfc3339(),
        })
        .collect();

    Ok(Json(response))
}

pub async fn create_user(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateUserRequest>,
) -> Result<Json<UserResponse>, StatusCode> {
    let password_hash = CryptoService::hash_password(&req.password)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let (public_key, _) = CryptoService::generate_keypair();
    let id = Uuid::new_v4();
    let now = chrono::Utc::now();

    sqlx::query(
        r#"
        INSERT INTO users (id, username, password_hash, public_key, is_admin, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(id)
    .bind(&req.username)
    .bind(&password_hash)
    .bind(&public_key)
    .bind(req.is_admin)
    .bind(now)
    .bind(now)
    .execute(state.db.get_pool())
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(UserResponse {
        id: user.id.to_string(),
        username: user.username,
        is_admin: user.is_admin,
        disabled: user.disabled,
        totp_enabled: user.totp_enabled,
        public_key: user.public_key,
        created_at: user.created_at.to_rfc3339(),
        updated_at: user.updated_at.to_rfc3339(),
    }))
}

pub async fn update_user(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateUserRequest>,
) -> Result<Json<UserResponse>, StatusCode> {
    if req.username.is_none() && req.disabled.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let new_username = req.username.unwrap_or(user.username);
    let new_disabled = req.disabled.unwrap_or(user.disabled);

    sqlx::query(
        "UPDATE users SET username = $1, disabled = $2, updated_at = NOW() WHERE id = $3",
    )
    .bind(&new_username)
    .bind(new_disabled)
    .bind(id)
    .execute(state.db.get_pool())
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(UserResponse {
        id: user.id.to_string(),
        username: user.username,
        is_admin: user.is_admin,
        disabled: user.disabled,
        totp_enabled: user.totp_enabled,
        public_key: user.public_key,
        created_at: user.created_at.to_rfc3339(),
        updated_at: user.updated_at.to_rfc3339(),
    }))
}

pub async fn delete_user(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn set_admin(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<SetAdminRequest>,
) -> Result<StatusCode, StatusCode> {
    let result = sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
        .bind(req.is_admin)
        .bind(id)
        .execute(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    Ok(StatusCode::OK)
}

pub async fn set_disabled(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(req): Json<SetAdminRequest>,
) -> Result<StatusCode, StatusCode> {
    let result = sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
        .bind(req.is_admin)
        .bind(id)
        .execute(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    Ok(StatusCode::OK)
}

pub async fn stats(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StatsResponse>, StatusCode> {
    let total_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let total_chats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chats")
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let total_messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL")
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let active_calls: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM active_calls WHERE status = 'active'",
    )
    .fetch_one(state.db.get_pool())
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(StatsResponse {
        total_users,
        total_chats,
        total_messages,
        active_calls: active_calls as i32,
        uptime_seconds: START_TIME.elapsed().as_secs(),
    }))
}
