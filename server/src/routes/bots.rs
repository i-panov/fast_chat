use axum::{
    extract::{Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::{Bot, BotChat, BotCommand},
    AppState,
};

fn generate_bot_token() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    format!("bot_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_bot_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(token.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hash)
}

#[derive(Debug, Deserialize)]
pub struct CreateBotRequest {
    pub username: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBotRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetWebhookRequest {
    pub webhook_url: String,
    pub webhook_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetUpdatesQuery {
    pub limit: Option<i32>,
    pub timeout: Option<u64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterCommandRequest {
    pub command: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddBotToChatRequest {
    pub chat_id: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct SendMessageRequest {
    pub chat_id: String,
    pub content: String,
    pub content_type: Option<String>,
    pub reply_to_message_id: Option<String>,
}

fn require_bot_token(headers: &HeaderMap) -> Result<String, AppError> {
    let auth = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    auth.strip_prefix("Bearer ")
        .map(String::from)
        .ok_or(AppError::InvalidToken)
}

async fn get_bot_by_token(state: &AppState, token: &str) -> Result<Bot, AppError> {
    let token_hash = hash_bot_token(token);
    sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE access_token_hash = $1 AND is_active = TRUE")
        .bind(token_hash)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::NotAuthorized)
}

fn bot_to_json(bot: &Bot, include_token: Option<&str>) -> serde_json::Value {
    let mut v = serde_json::json!({
        "id": bot.id.to_string(), "owner_id": bot.owner_id.map(|id| id.to_string()), "username": bot.username,
        "display_name": bot.display_name, "description": bot.description, "avatar_url": bot.avatar_url,
        "webhook_url": bot.webhook_url, "delivery_mode": bot.delivery_mode,
        "is_active": bot.is_active, "is_master": bot.is_master, "created_at": bot.created_at.to_rfc3339(),
    });
    if let Some(t) = include_token {
        v["access_token"] = serde_json::Value::String(t.to_string());
    }
    v
}

async fn verify_owner(state: &AppState, bot_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM bots WHERE id = $1 AND owner_id = $2")
            .bind(bot_id)
            .bind(user_id)
            .fetch_optional(state.db.get_pool())
            .await?;
    if exists.is_none() {
        return Err(AppError::Validation("Bot not found".to_string()));
    }
    Ok(())
}

pub async fn create_bot(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateBotRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let mut username = req.username.trim().to_lowercase();
    if !username.ends_with("_bot") {
        username = format!("{}_bot", username);
    }
    if !username.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(AppError::Validation(
            "Username must be alphanumeric + underscores".to_string(),
        ));
    }
    let token = generate_bot_token();
    let token_hash = hash_bot_token(&token);
    let now = Utc::now();
    let bot = sqlx::query_as::<_, Bot>("INSERT INTO bots (owner_id, username, display_name, description, access_token_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *")
        .bind(user_id).bind(&username).bind(&req.display_name).bind(&req.description).bind(&token_hash).bind(now).bind(now)
        .fetch_one(state.db.get_pool()).await?;
    Ok(Json(bot_to_json(&bot, Some(&token))))
}

pub async fn list_bots(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bots =
        sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE owner_id = $1 ORDER BY created_at DESC")
            .bind(user_id)
            .fetch_all(state.db.get_pool())
            .await?;
    Ok(Json(bots.iter().map(|b| bot_to_json(b, None)).collect()))
}

pub async fn get_bot(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let bot = sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE id = $1")
        .bind(bot_id)
        .fetch_one(state.db.get_pool())
        .await?;
    Ok(Json(bot_to_json(&bot, None)))
}

pub async fn update_bot(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateBotRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let now = Utc::now();
    sqlx::query("UPDATE bots SET display_name = COALESCE($1, display_name), description = COALESCE($2, description), avatar_url = COALESCE($3, avatar_url), updated_at = $4 WHERE id = $5")
        .bind(&req.display_name).bind(&req.description).bind(&req.avatar_url).bind(now).bind(bot_id)
        .execute(state.db.get_pool()).await?;
    let bot = sqlx::query_as::<_, Bot>("SELECT * FROM bots WHERE id = $1")
        .bind(bot_id)
        .fetch_one(state.db.get_pool())
        .await?;
    Ok(Json(bot_to_json(&bot, None)))
}

pub async fn delete_bot(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    sqlx::query("DELETE FROM bots WHERE id = $1 AND owner_id = $2 AND is_master = FALSE")
        .bind(bot_id)
        .bind(actual_user_id)
        .execute(state.db.get_pool())
        .await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn regenerate_token(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let token = generate_bot_token();
    let token_hash = hash_bot_token(&token);
    sqlx::query("UPDATE bots SET access_token_hash = $1, updated_at = NOW() WHERE id = $2")
        .bind(&token_hash)
        .bind(bot_id)
        .execute(state.db.get_pool())
        .await?;
    Ok(Json(serde_json::json!({"access_token": token})))
}

pub async fn set_webhook(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SetWebhookRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    sqlx::query("UPDATE bots SET webhook_url = $1, webhook_secret = $2, delivery_mode = 'webhook', updated_at = NOW() WHERE id = $3")
        .bind(&req.webhook_url).bind(&req.webhook_secret).bind(bot_id).execute(state.db.get_pool()).await?;
    Ok(Json(
        serde_json::json!({"success": true, "webhook_url": req.webhook_url}),
    ))
}

pub async fn delete_webhook(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    sqlx::query("UPDATE bots SET webhook_url = NULL, webhook_secret = NULL, delivery_mode = 'polling', updated_at = NOW() WHERE id = $1").bind(bot_id).execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn list_commands(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let commands = sqlx::query_as::<_, BotCommand>(
        "SELECT * FROM bot_commands WHERE bot_id = $1 ORDER BY command",
    )
    .bind(bot_id)
    .fetch_all(state.db.get_pool())
    .await?;
    Ok(Json(
        commands
            .iter()
            .map(|c| serde_json::json!({"command": c.command, "description": c.description}))
            .collect(),
    ))
}

pub async fn register_command(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<RegisterCommandRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let mut command = req.command.trim().to_lowercase();
    if command.starts_with('/') {
        command = command[1..].to_string();
    }
    sqlx::query("INSERT INTO bot_commands (bot_id, command, description) VALUES ($1, $2, $3) ON CONFLICT (bot_id, command) DO UPDATE SET description = $3")
        .bind(bot_id).bind(&command).bind(&req.description).execute(state.db.get_pool()).await?;
    Ok(Json(
        serde_json::json!({"success": true, "command": command}),
    ))
}

pub async fn delete_command(
    State(state): State<std::sync::Arc<AppState>>,
    Path((id, cmd)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    sqlx::query("DELETE FROM bot_commands WHERE bot_id = $1 AND command = $2 AND bot_id IN (SELECT id FROM bots WHERE owner_id = $3)")
        .bind(bot_id).bind(&cmd).bind(actual_user_id).execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn list_bot_chats(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let chats = sqlx::query_as::<_, BotChat>(
        "SELECT * FROM bot_chats WHERE bot_id = $1 ORDER BY created_at DESC",
    )
    .bind(bot_id)
    .fetch_all(state.db.get_pool())
    .await?;
    Ok(Json(chats.iter().map(|bc| serde_json::json!({"chat_id": bc.chat_id.to_string(), "added_at": bc.created_at.to_rfc3339()})).collect()))
}

pub async fn add_to_chat(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<AddBotToChatRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    let chat_id: Uuid = req
        .chat_id
        .parse()
        .map_err(|_| AppError::Validation("Invalid chat ID".to_string()))?;
    verify_owner(&state, bot_id, actual_user_id).await?;
    let _: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2")
            .bind(chat_id)
            .bind(actual_user_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or(AppError::Validation(
                "You are not a participant in this chat".to_string(),
            ))?;
    sqlx::query("INSERT INTO bot_chats (bot_id, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(bot_id)
        .bind(chat_id)
        .execute(state.db.get_pool())
        .await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn remove_from_chat(
    State(state): State<std::sync::Arc<AppState>>,
    Path((id, chat_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let actual_user_id = get_user_id_from_request(
        headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::InvalidToken)?,
        &state.settings.jwt_secret,
    )?;
    let bot_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid bot ID".to_string()))?;
    let chat_uuid: Uuid = chat_id
        .parse()
        .map_err(|_| AppError::Validation("Invalid chat ID".to_string()))?;
    sqlx::query("DELETE FROM bot_chats WHERE bot_id = $1 AND chat_id = $2 AND bot_id IN (SELECT id FROM bots WHERE owner_id = $3)")
        .bind(bot_id).bind(chat_uuid).bind(actual_user_id).execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn bot_api_me(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = require_bot_token(&headers)?;
    let bot = get_bot_by_token(&state, &token).await?;
    Ok(Json(
        serde_json::json!({"id": bot.id.to_string(), "username": bot.username, "display_name": bot.display_name, "description": bot.description, "is_master": bot.is_master, "delivery_mode": bot.delivery_mode, "webhook_url": bot.webhook_url}),
    ))
}

pub async fn bot_api_get_updates(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<GetUpdatesQuery>,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let token = require_bot_token(&headers)?;
    let bot = get_bot_by_token(&state, &token).await?;
    if bot.delivery_mode == "webhook" {
        return Err(AppError::Validation(
            "Cannot use polling when webhook is set".to_string(),
        ));
    }
    let limit = params.limit.unwrap_or(10).min(100);
    let timeout_secs = params.timeout.unwrap_or(30).min(60);
    let offset = params.offset.unwrap_or(0);
    let start = std::time::Instant::now();
    loop {
        let updates: Vec<(Uuid, String, serde_json::Value, i64)> = sqlx::query_as(
            "SELECT id, update_type, payload, EXTRACT(EPOCH FROM created_at)::bigint FROM bot_updates WHERE bot_id = $1 AND delivered = FALSE AND EXTRACT(EPOCH FROM created_at)::bigint > $2 ORDER BY created_at ASC LIMIT $3"
        ).bind(bot.id).bind(offset).bind(limit).fetch_all(state.db.get_pool()).await?;
        if !updates.is_empty() {
            for (upd_id, _, _, _) in &updates {
                sqlx::query("UPDATE bot_updates SET delivered = TRUE WHERE id = $1")
                    .bind(upd_id)
                    .execute(state.db.get_pool())
                    .await?;
            }
            return Ok(Json(updates.iter().map(|(_, update_type, payload, ts)| serde_json::json!({"update_type": update_type, "payload": payload, "timestamp": ts})).collect()));
        }
        if start.elapsed().as_secs() >= timeout_secs {
            return Ok(Json(vec![]));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub async fn bot_api_send_message(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let token = require_bot_token(&headers)?;
    let bot = get_bot_by_token(&state, &token).await?;
    let chat_id: Uuid = req
        .chat_id
        .parse()
        .map_err(|_| AppError::Validation("Invalid chat ID".to_string()))?;
    let _: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM bot_chats WHERE bot_id = $1 AND chat_id = $2")
            .bind(bot.id)
            .bind(chat_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or(AppError::Validation(
                "Bot is not a member of this chat".to_string(),
            ))?;
    let msg_id = Uuid::new_v4();
    let now = Utc::now();
    let content_type = req.content_type.unwrap_or("text".to_string());
    sqlx::query("INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, status, created_at) VALUES ($1, $2, $3, $4, $5, 'sent', $6)")
        .bind(msg_id).bind(chat_id).bind(bot.id).bind(&req.content).bind(&content_type).bind(now).execute(state.db.get_pool()).await?;
    let event = serde_json::json!({"type": "new_message", "chat_id": chat_id.to_string(), "sender_id": bot.id.to_string(), "is_bot": true, "data": {"id": msg_id.to_string(), "encrypted_content": req.content, "content_type": content_type, "created_at": now.to_rfc3339()}});
    let channel = format!("chat:{}:events", chat_id);
    let _ = state.redis.publish(&channel, &event.to_string()).await;
    Ok(Json(
        serde_json::json!({"id": msg_id.to_string(), "chat_id": chat_id.to_string(), "created_at": now.to_rfc3339()}),
    ))
}
