use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, header::AUTHORIZATION},
    Json,
};
use chrono::Utc;
use uuid::Uuid;

use crate::{
    crypto::CryptoService,
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::User,
    routes::dto::{self, Ack, UserResponse},
    AppState,
};

pub async fn require_admin(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<Uuid, AppError> {
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

    Ok(user_id)
}

pub async fn list_users(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<UserResponse>>, AppError> {
    require_admin(&headers, &state).await?;

    let page = params.get("page").and_then(|p| p.parse::<i32>().ok()).unwrap_or(1);
    let page_size = params.get("page_size").and_then(|p| p.parse::<i32>().ok()).unwrap_or(50);
    let offset = (page - 1) * page_size;

    let users = sqlx::query_as::<_, User>(
        "SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    )
    .bind(page_size)
    .bind(offset)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(users.iter().map(UserResponse::from).collect()))
}

pub async fn create_user(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::CreateUserRequest>,
) -> Result<Json<UserResponse>, AppError> {
    require_admin(&headers, &state).await?;

    let password_hash = CryptoService::hash_password(&req.password)
        .map_err(|_| AppError::Internal)?;
    let (public_key, _) = CryptoService::generate_keypair();
    let id = Uuid::new_v4();
    let now = Utc::now();
    let is_admin = req.is_admin.unwrap_or(false);

    sqlx::query(
        r#"
        INSERT INTO users (id, username, email, password_hash, public_key, is_admin, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (username) DO NOTHING
        "#,
    )
    .bind(id)
    .bind(&req.username)
    .bind(req.email.as_deref().unwrap_or(""))
    .bind(&password_hash)
    .bind(&public_key)
    .bind(is_admin)
    .bind(now)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await?;

    Ok(Json(UserResponse::from(&user)))
}

pub async fn get_user(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<UserResponse>, AppError> {
    let id: Uuid = id.parse().map_err(|_| AppError::UserNotFound)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    Ok(Json(UserResponse::from(&user)))
}

pub async fn update_user(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::UpdateUserRequest>,
) -> Result<Json<UserResponse>, AppError> {
    require_admin(&headers, &state).await?;

    let id: Uuid = id.parse().map_err(|_| AppError::UserNotFound)?;

    if let Some(ref username) = req.username {
        sqlx::query("UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2")
            .bind(username)
            .bind(id)
            .execute(state.db.get_pool())
            .await?;
    }
    if let Some(ref email) = req.email {
        sqlx::query("UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2")
            .bind(email)
            .bind(id)
            .execute(state.db.get_pool())
            .await?;
    }

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    Ok(Json(UserResponse::from(&user)))
}

pub async fn delete_user(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Ack>, AppError> {
    require_admin(&headers, &state).await?;

    let id: Uuid = id.parse().map_err(|_| AppError::UserNotFound)?;

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(Ack { success: true, message: "User deleted".to_string() }))
}

pub async fn set_admin(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<UserResponse>, AppError> {
    require_admin(&headers, &state).await?;

    let id: Uuid = id.parse().map_err(|_| AppError::UserNotFound)?;
    let yes = body.get("yes").and_then(|v| v.as_bool()).unwrap_or(false);

    sqlx::query("UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2")
        .bind(yes)
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    Ok(Json(UserResponse::from(&user)))
}

pub async fn set_disabled(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<UserResponse>, AppError> {
    require_admin(&headers, &state).await?;

    let id: Uuid = id.parse().map_err(|_| AppError::UserNotFound)?;
    let yes = body.get("yes").and_then(|v| v.as_bool()).unwrap_or(false);

    sqlx::query("UPDATE users SET disabled = $1, updated_at = NOW() WHERE id = $2")
        .bind(yes)
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    Ok(Json(UserResponse::from(&user)))
}
