use axum::{
    extract::{Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::{Channel, ChannelSubscriber},
    AppState,
};

// ─── Request types ───

#[derive(Debug, Deserialize)]
pub struct CreateChannelRequest {
    pub title: String,
    pub description: Option<String>,
    pub username: Option<String>,
    pub access_level: String, // public, private, private_with_approval
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChannelRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub username: Option<String>,
    pub access_level: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendChannelMessageRequest {
    pub content: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetMessagesQuery {
    pub limit: Option<i32>,
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

// ─── Helpers ───

fn extract_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth, &state.settings.jwt_secret)
}

async fn verify_channel_owner(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<Channel, AppError> {
    let ch = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE id = $1 AND owner_id = $2 AND is_active = TRUE",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(state.db.get_pool())
    .await?
    .ok_or(AppError::Validation(
        "Channel not found or you are not the owner".to_string(),
    ))?;
    Ok(ch)
}

async fn verify_subscriber(
    state: &AppState,
    channel_id: Uuid,
    user_id: Uuid,
) -> Result<ChannelSubscriber, AppError> {
    let sub = sqlx::query_as::<_, ChannelSubscriber>(
        "SELECT * FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND status = 'active'"
    ).bind(channel_id).bind(user_id)
    .fetch_optional(state.db.get_pool()).await?
    .ok_or(AppError::Validation("You are not a subscriber of this channel".to_string()))?;
    Ok(sub)
}

fn channel_to_json(ch: &Channel, is_subscriber: bool) -> serde_json::Value {
    serde_json::json!({
        "id": ch.id.to_string(),
        "owner_id": ch.owner_id.to_string(),
        "title": ch.title,
        "description": ch.description,
        "username": ch.username,
        "access_level": ch.access_level,
        "avatar_url": ch.avatar_url,
        "subscribers_count": ch.subscribers_count,
        "is_subscriber": is_subscriber,
        "created_at": ch.created_at.to_rfc3339(),
    })
}

// ─── Channel CRUD ───

/// POST /api/channels — Create a channel
pub async fn create_channel(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;

    let valid_levels = &["public", "private", "private_with_approval"];
    if !valid_levels.contains(&req.access_level.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid access_level. Must be one of: {:?}",
            valid_levels
        )));
    }

    let username = req.username.as_ref().map(|u| {
        let u = u.trim().to_lowercase();
        if let Some(stripped) = u.strip_prefix('@') {
            stripped.to_string()
        } else {
            u
        }
    });

    if let Some(ref u) = username {
        if !u.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(AppError::Validation(
                "Username must be alphanumeric + underscores".to_string(),
            ));
        }
    }

    let now = Utc::now();
    let ch = sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (owner_id, title, description, username, access_level, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *"
    )
    .bind(user_id).bind(&req.title).bind(&req.description).bind(&username)
    .bind(&req.access_level).bind(&req.avatar_url).bind(now).bind(now)
    .fetch_one(state.db.get_pool()).await?;

    // Auto-subscribe owner
    sqlx::query("INSERT INTO channel_subscribers (channel_id, user_id, status) VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING")
        .bind(ch.id).bind(user_id).execute(state.db.get_pool()).await?;

    Ok(Json(channel_to_json(&ch, true)))
}

/// GET /api/channels — List user's channels (owned + subscribed)
pub async fn list_channels(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;

    let channels = sqlx::query_as::<_, Channel>(
        "SELECT DISTINCT c.* FROM channels c
         LEFT JOIN channel_subscribers cs ON c.id = cs.channel_id
         WHERE c.owner_id = $1 OR (cs.user_id = $1 AND cs.status = 'active')
         ORDER BY c.updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    let result: Vec<serde_json::Value> = channels
        .iter()
        .map(|ch| {
            let is_sub = ch.owner_id != user_id;
            channel_to_json(ch, is_sub)
        })
        .collect();

    Ok(Json(result))
}

/// GET /api/channels/search — Search public channels
pub async fn search_channels(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SearchQuery>,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let _user_id = extract_user_id(&headers, &state)?;

    let query = format!("%{}%", q.q);
    let channels = sqlx::query_as::<_, Channel>(
        "SELECT * FROM channels WHERE access_level = 'public' AND is_active = TRUE \
         AND (title ILIKE $1 OR username ILIKE $1) ORDER BY subscribers_count DESC LIMIT 50",
    )
    .bind(&query)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(
        channels
            .iter()
            .map(|ch| channel_to_json(ch, false))
            .collect(),
    ))
}

/// GET /api/channels/:id
pub async fn get_channel(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    let ch =
        sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1 AND is_active = TRUE")
            .bind(ch_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or(AppError::Validation("Channel not found".to_string()))?;

    // Private channels: only subscribers or owner can see details
    if ch.access_level != "public" {
        let is_subscribed: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND status IN ('active', 'pending')"
        ).bind(ch_id).bind(user_id).fetch_optional(state.db.get_pool()).await?;

        let is_owner = ch.owner_id == user_id;
        if is_subscribed.is_none() && !is_owner {
            return Err(AppError::NotAuthorized);
        }
    }

    let is_subscriber: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND status = 'active'"
    ).bind(ch_id).bind(user_id).fetch_optional(state.db.get_pool()).await?;

    let is_owner = ch.owner_id == user_id;

    Ok(Json(channel_to_json(
        &ch,
        is_subscriber.is_some() || is_owner,
    )))
}

/// PUT /api/channels/:id
pub async fn update_channel(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    verify_channel_owner(&state, ch_id, user_id).await?;

    let username = req.username.as_ref().map(|u| {
        let u = u.trim().to_lowercase();
        if let Some(stripped) = u.strip_prefix('@') {
            stripped.to_string()
        } else {
            u
        }
    });

    if let Some(ref u) = username {
        if !u.is_empty() && !u.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(AppError::Validation(
                "Username must be alphanumeric + underscores".to_string(),
            ));
        }
    }

    let valid_levels = &["public", "private", "private_with_approval"];
    if let Some(ref level) = req.access_level {
        if !valid_levels.contains(&level.as_str()) {
            return Err(AppError::Validation(format!(
                "Invalid access_level. Must be one of: {:?}",
                valid_levels
            )));
        }
    }

    let now = Utc::now();
    sqlx::query(
        "UPDATE channels SET title = COALESCE($1, title), description = COALESCE($2, description), \
         username = COALESCE($3, username), access_level = COALESCE($4, access_level), \
         avatar_url = COALESCE($5, avatar_url), updated_at = $6 WHERE id = $7"
    )
    .bind(&req.title).bind(&req.description).bind(&username)
    .bind(&req.access_level).bind(&req.avatar_url).bind(now).bind(ch_id)
    .execute(state.db.get_pool()).await?;

    let ch = sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1")
        .bind(ch_id)
        .fetch_one(state.db.get_pool())
        .await?;

    Ok(Json(channel_to_json(&ch, true)))
}

/// DELETE /api/channels/:id
pub async fn delete_channel(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    verify_channel_owner(&state, ch_id, user_id).await?;

    sqlx::query("UPDATE channels SET is_active = FALSE, updated_at = NOW() WHERE id = $1")
        .bind(ch_id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(serde_json::json!({"success": true})))
}

// ─── Messages ───

/// POST /api/channels/:id/messages — Send message (owner only)
pub async fn send_message(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<SendChannelMessageRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    let ch = verify_channel_owner(&state, ch_id, user_id).await?;

    let msg_id = Uuid::new_v4();
    let now = Utc::now();
    let content_type = req.content_type.unwrap_or("text".to_string());

    sqlx::query(
        "INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, status, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'sent', $6)"
    )
    .bind(msg_id).bind(ch_id).bind(user_id).bind(&req.content).bind(&content_type).bind(now)
    .execute(state.db.get_pool()).await?;

    // Notify all subscribers via SSE
    let event = serde_json::json!({
        "type": "channel_message",
        "channel_id": ch_id.to_string(),
        "data": {
            "id": msg_id.to_string(),
            "encrypted_content": req.content,
            "content_type": content_type,
            "created_at": now.to_rfc3339(),
        }
    });
    let channel = format!("channel:{}:events", ch_id);
    let _ = state.redis.publish(&channel, &event.to_string()).await;

    // Send push notifications to subscribers
    let subscribers: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM channel_subscribers WHERE channel_id = $1 AND status = 'active'",
    )
    .bind(ch_id)
    .fetch_all(state.db.get_pool())
    .await?;

    for sub_id in &subscribers {
        if *sub_id == user_id {
            continue;
        }
        let is_muted = crate::routes::push::is_chat_muted(&state, *sub_id, None, Some(ch_id))
            .await
            .unwrap_or(false);
        if !is_muted {
            let _ = crate::routes::push::send_push_notification(
                &state, *sub_id, &ch.title, "New channel message",
                Some(&serde_json::json!({"channel_id": ch_id.to_string(), "message_id": msg_id.to_string()}))
            ).await;
        }
    }

    Ok(Json(serde_json::json!({
        "id": msg_id.to_string(),
        "channel_id": ch_id.to_string(),
        "created_at": now.to_rfc3339(),
    })))
}

/// GET /api/channels/:id/messages — Get messages (subscribers only)
pub async fn get_messages(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<GetMessagesQuery>,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    // Owner can always read
    let ch =
        sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1 AND is_active = TRUE")
            .bind(ch_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or(AppError::Validation("Channel not found".to_string()))?;

    if ch.owner_id != user_id {
        verify_subscriber(&state, ch_id, user_id).await?;
    }

    let limit = params.limit.unwrap_or(50).min(100);
    let offset = params.offset.unwrap_or(0);

    let messages = sqlx::query_as::<_, (Uuid, String, String, String, String, chrono::DateTime<Utc>)>(
        "SELECT id, encrypted_content, content_type, status, created_at::text, sender_id::text \
         FROM messages WHERE chat_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ).bind(ch_id).bind(limit).bind(offset).fetch_all(state.db.get_pool()).await?;

    Ok(Json(
        messages
            .iter()
            .map(|(id, content, ctype, status, created_at, sender)| {
                serde_json::json!({
                    "id": id.to_string(),
                    "encrypted_content": content,
                    "content_type": ctype,
                    "status": status,
                    "created_at": created_at,
                    "sender_id": sender,
                })
            })
            .collect(),
    ))
}

// ─── Subscriptions ───

/// POST /api/channels/:id/subscribe
pub async fn subscribe(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    let ch =
        sqlx::query_as::<_, Channel>("SELECT * FROM channels WHERE id = $1 AND is_active = TRUE")
            .bind(ch_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or(AppError::Validation("Channel not found".to_string()))?;

    // Check if already subscribed
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT status FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2",
    )
    .bind(ch_id)
    .bind(user_id)
    .fetch_optional(state.db.get_pool())
    .await?;

    if existing.is_some() {
        return Err(AppError::Validation(
            "Already subscribed or request pending".to_string(),
        ));
    }

    let status = if ch.access_level == "private_with_approval" {
        "pending"
    } else {
        "active"
    };

    sqlx::query(
        "INSERT INTO channel_subscribers (channel_id, user_id, status) VALUES ($1, $2, $3)",
    )
    .bind(ch_id)
    .bind(user_id)
    .bind(status)
    .execute(state.db.get_pool())
    .await?;

    if status == "active" {
        sqlx::query("UPDATE channels SET subscribers_count = subscribers_count + 1 WHERE id = $1")
            .bind(ch_id)
            .execute(state.db.get_pool())
            .await?;
    }

    if status == "pending" {
        return Ok(Json(serde_json::json!({
            "success": true,
            "status": "pending",
            "message": "Subscription request sent. Waiting for admin approval.",
        })));
    }

    Ok(Json(
        serde_json::json!({"success": true, "status": "active"}),
    ))
}

/// POST /api/channels/:id/unsubscribe
pub async fn unsubscribe(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    sqlx::query("DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND user_id != (SELECT owner_id FROM channels WHERE id = $1)")
        .bind(ch_id).bind(user_id).execute(state.db.get_pool()).await?;

    sqlx::query(
        "UPDATE channels SET subscribers_count = GREATEST(subscribers_count - 1, 0) WHERE id = $1",
    )
    .bind(ch_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({"success": true})))
}

/// GET /api/channels/:id/subscribers — List subscribers (owner only)
pub async fn list_subscribers(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    verify_channel_owner(&state, ch_id, user_id).await?;

    let subs = sqlx::query_as::<_, ChannelSubscriber>(
        "SELECT * FROM channel_subscribers WHERE channel_id = $1 AND status = 'active' ORDER BY joined_at DESC"
    ).bind(ch_id).fetch_all(state.db.get_pool()).await?;

    // Enrich with user info
    let mut result = Vec::new();
    for sub in subs {
        let username: Option<String> =
            sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
                .bind(sub.user_id)
                .fetch_optional(state.db.get_pool())
                .await?
                .flatten();
        result.push(serde_json::json!({
            "user_id": sub.user_id.to_string(),
            "username": username,
            "status": sub.status,
            "joined_at": sub.joined_at.to_rfc3339(),
        }));
    }

    Ok(Json(result))
}

/// DELETE /api/channels/:id/subscribers/:user_id — Remove subscriber (owner only)
pub async fn remove_subscriber(
    State(state): State<std::sync::Arc<AppState>>,
    Path((ch_id_str, user_id_str)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let owner_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = ch_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;
    let sub_user_id: Uuid = user_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid user ID".to_string()))?;

    verify_channel_owner(&state, ch_id, owner_id).await?;

    sqlx::query("DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND status = 'active'")
        .bind(ch_id).bind(sub_user_id).execute(state.db.get_pool()).await?;

    sqlx::query(
        "UPDATE channels SET subscribers_count = GREATEST(subscribers_count - 1, 0) WHERE id = $1",
    )
    .bind(ch_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({"success": true})))
}

// ─── Join Requests (for private_with_approval) ───

/// GET /api/channels/:id/requests — List pending requests (owner only)
pub async fn list_requests(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = id
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;

    verify_channel_owner(&state, ch_id, user_id).await?;

    let requests = sqlx::query_as::<_, ChannelSubscriber>(
        "SELECT * FROM channel_subscribers WHERE channel_id = $1 AND status = 'pending' ORDER BY joined_at DESC"
    ).bind(ch_id).fetch_all(state.db.get_pool()).await?;

    let mut result = Vec::new();
    for req in requests {
        let username: Option<String> =
            sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
                .bind(req.user_id)
                .fetch_optional(state.db.get_pool())
                .await?
                .flatten();
        result.push(serde_json::json!({
            "user_id": req.user_id.to_string(),
            "username": username,
            "requested_at": req.joined_at.to_rfc3339(),
        }));
    }

    Ok(Json(result))
}

/// POST /api/channels/:id/requests/:user_id/approve
pub async fn approve_request(
    State(state): State<std::sync::Arc<AppState>>,
    Path((ch_id_str, user_id_str)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let owner_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = ch_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;
    let req_user_id: Uuid = user_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid user ID".to_string()))?;

    verify_channel_owner(&state, ch_id, owner_id).await?;

    let updated = sqlx::query(
        "UPDATE channel_subscribers SET status = 'active' WHERE channel_id = $1 AND user_id = $2 AND status = 'pending'"
    ).bind(ch_id).bind(req_user_id).execute(state.db.get_pool()).await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::Validation(
            "No pending request found for this user".to_string(),
        ));
    }

    sqlx::query("UPDATE channels SET subscribers_count = subscribers_count + 1 WHERE id = $1")
        .bind(ch_id)
        .execute(state.db.get_pool())
        .await?;

    // Notify user via SSE
    let event = serde_json::json!({
        "type": "channel_subscription_approved",
        "channel_id": ch_id.to_string(),
    });
    let channel = format!("user:{}:events", req_user_id);
    let _ = state.redis.publish(&channel, &event.to_string()).await;

    Ok(Json(serde_json::json!({"success": true})))
}

/// POST /api/channels/:id/requests/:user_id/reject
pub async fn reject_request(
    State(state): State<std::sync::Arc<AppState>>,
    Path((ch_id_str, user_id_str)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let owner_id = extract_user_id(&headers, &state)?;
    let ch_id: Uuid = ch_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid channel ID".to_string()))?;
    let req_user_id: Uuid = user_id_str
        .parse()
        .map_err(|_| AppError::Validation("Invalid user ID".to_string()))?;

    verify_channel_owner(&state, ch_id, owner_id).await?;

    let updated = sqlx::query(
        "DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2 AND status = 'pending'"
    ).bind(ch_id).bind(req_user_id).execute(state.db.get_pool()).await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::Validation(
            "No pending request found for this user".to_string(),
        ));
    }

    // Notify user
    let event = serde_json::json!({
        "type": "channel_subscription_rejected",
        "channel_id": ch_id.to_string(),
    });
    let channel = format!("user:{}:events", req_user_id);
    let _ = state.redis.publish(&channel, &event.to_string()).await;

    Ok(Json(serde_json::json!({"success": true})))
}
