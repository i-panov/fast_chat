use axum::{
    extract::{Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use chrono::Utc;
use tracing::{error, info};
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::{Chat, Message, PinnedMessage, Thread, Topic},
    routes::dto::{
        self, Ack, ChatResponse, MessageResponse, MessagesPage, ThreadResponse, TopicResponse,
    },
    AppState,
};

pub async fn get_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth_header, &state.settings.jwt_secret)
}

pub async fn check_chat_participation(
    state: &AppState,
    chat_id: Uuid,
    user_id: Uuid,
) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2)",
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_one(state.db.get_pool())
    .await?;
    Ok(exists)
}

pub async fn get_chats(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<ChatResponse>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let chats = sqlx::query_as::<_, Chat>(
        r#"
        SELECT c.* FROM chats c
        JOIN chat_participants cp ON c.id = cp.chat_id
        LEFT JOIN hidden_chats hc ON c.id = hc.chat_id AND hc.user_id = $1
        WHERE cp.user_id = $1 AND hc.user_id IS NULL
        ORDER BY c.created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    let mut result = Vec::new();
    for chat in &chats {
        let participants: Vec<String> =
            sqlx::query_scalar("SELECT user_id::text FROM chat_participants WHERE chat_id = $1")
                .bind(chat.id)
                .fetch_all(state.db.get_pool())
                .await?;

        let mut resp = ChatResponse::from(chat);
        resp.participants = participants.clone();

        // For direct chats (not group, 2 participants), show the other user's name
        if !chat.is_group && participants.len() == 2 {
            let other_user_id = participants.iter()
                .find(|p| p.as_str() != user_id.to_string())
                .and_then(|p| Uuid::parse_str(p).ok());

            if let Some(other_id) = other_user_id {
                let username: Option<String> = sqlx::query_scalar(
                    "SELECT username FROM users WHERE id = $1"
                )
                .bind(other_id)
                .fetch_optional(state.db.get_pool())
                .await?;

                if let Some(name) = username {
                    resp.name = Some(name);
                }
            }
        }

        result.push(resp);
    }

    Ok(Json(result))
}

pub async fn create_chat(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::CreateChatRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    // For direct (non-group) chats with exactly 1 participant,
    // check if a chat already exists between these two users
    if !req.is_group && req.participants.len() == 1 {
        let other_id = Uuid::parse_str(&req.participants[0]).ok();
        if let Some(other_id) = other_id {
            // Find existing direct chat between user_id and other_id
            let existing_chat: Option<Chat> = sqlx::query_as(
                "SELECT c.* FROM chats c
                 INNER JOIN chat_participants p1 ON p1.chat_id = c.id AND p1.user_id = $1
                 INNER JOIN chat_participants p2 ON p2.chat_id = c.id AND p2.user_id = $2
                 WHERE c.is_group = FALSE
                 LIMIT 1",
            )
            .bind(user_id)
            .bind(other_id)
            .fetch_optional(state.db.get_pool())
            .await?;

            if let Some(chat) = existing_chat {
                let participants: Vec<String> =
                    sqlx::query_scalar("SELECT user_id::text FROM chat_participants WHERE chat_id = $1")
                        .bind(chat.id)
                        .fetch_all(state.db.get_pool())
                        .await?;

                let mut resp = ChatResponse::from(&chat);
                resp.participants = participants;
                return Ok(Json(resp));
            }
        }
    }

    let id = Uuid::new_v4();
    let now = Utc::now();

    sqlx::query(
        r#"
        INSERT INTO chats (id, is_group, name, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(id)
    .bind(req.is_group)
    .bind(&req.name)
    .bind(user_id)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    sqlx::query("INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)")
        .bind(id)
        .bind(user_id)
        .execute(state.db.get_pool())
        .await?;

    for participant_id in &req.participants {
        if let Ok(pid) = Uuid::parse_str(participant_id) {
            sqlx::query("INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)")
                .bind(id)
                .bind(pid)
                .execute(state.db.get_pool())
                .await?;
        }
    }

    let chat = sqlx::query_as::<_, Chat>("SELECT * FROM chats WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await?;

    let participants: Vec<String> =
        sqlx::query_scalar("SELECT user_id::text FROM chat_participants WHERE chat_id = $1")
            .bind(id)
            .fetch_all(state.db.get_pool())
            .await?;

    let mut resp = ChatResponse::from(&chat);
    resp.participants = participants;

    Ok(Json(resp))
}

pub async fn get_chat(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ChatResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let chat = sqlx::query_as::<_, Chat>("SELECT * FROM chats WHERE id = $1")
        .bind(chat_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::ChatNotFound)?;

    let participants: Vec<String> =
        sqlx::query_scalar("SELECT user_id::text FROM chat_participants WHERE chat_id = $1")
            .bind(chat_id)
            .fetch_all(state.db.get_pool())
            .await?;

    let mut resp = ChatResponse::from(&chat);
    resp.participants = participants;

    Ok(Json(resp))
}

pub async fn hide_chat(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    sqlx::query(
        "INSERT INTO hidden_chats (user_id, chat_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(chat_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(Ack {
        success: true,
        message: "Chat hidden".to_string(),
    }))
}

pub async fn get_messages(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
    Query(params): Query<dto::GetMessagesQuery>,
) -> Result<Json<MessagesPage>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    // If chat is hidden for this user, return empty list
    let is_hidden: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM hidden_chats WHERE chat_id = $1 AND user_id = $2)",
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_one(state.db.get_pool())
    .await?;

    if is_hidden {
        return Ok(Json(MessagesPage {
            messages: vec![],
            has_more: false,
            next_cursor: "0".to_string(),
        }));
    }

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let page_size = params.limit.unwrap_or(50).clamp(1, 100);
    let cursor = params.cursor.unwrap_or(0);

    let topic_filter = params
        .topic_id
        .as_ref()
        .filter(|s| !s.is_empty())
        .and_then(|s| Uuid::parse_str(s).ok());

    let messages: Vec<Message> = match topic_filter {
        Some(tid) => sqlx::query_as(
            "SELECT * FROM messages WHERE chat_id = $1 AND deleted_at IS NULL AND topic_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        )
        .bind(chat_id)
        .bind(tid)
        .bind(page_size)
        .bind(cursor)
        .fetch_all(state.db.get_pool())
        .await?,
        None => sqlx::query_as(
            "SELECT * FROM messages WHERE chat_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(chat_id)
        .bind(page_size)
        .bind(cursor)
        .fetch_all(state.db.get_pool())
        .await?,
    };

    let has_more = messages.len() as i32 == page_size;

    Ok(Json(MessagesPage {
        messages: messages.iter().map(MessageResponse::from).collect(),
        has_more,
        next_cursor: format!("{}", cursor + messages.len() as i32),
    }))
}

pub async fn send_message(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::SendMessageRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = req.chat_id.parse().map_err(|_| {
        info!("send_message: failed to parse chat_id: {}", req.chat_id);
        AppError::ChatNotFound
    })?;

    info!("send_message: user_id={}, chat_id={}", user_id, chat_id);

    let is_participant = check_chat_participation(&state, chat_id, user_id).await?;
    if !is_participant {
        info!("send_message: user {} not participant in chat {}", user_id, chat_id);
        return Err(AppError::NotAuthorized);
    }

    let id = Uuid::new_v4();
    let now = Utc::now();
    let content_type = req.content_type.unwrap_or("text".to_string());

    let file_metadata_id = req
        .file_metadata_id
        .as_ref()
        .and_then(|s| Uuid::parse_str(s).ok());

    let topic_id = req
        .topic_id
        .as_ref()
        .filter(|s| !s.is_empty())
        .and_then(|s| Uuid::parse_str(s).ok());

    let thread_id = req
        .thread_id
        .as_ref()
        .filter(|s| !s.is_empty())
        .and_then(|s| Uuid::parse_str(s).ok());

    info!("send_message: inserting message id={}, chat_id={}, content_len={}", id, chat_id, req.content.len());

    sqlx::query(
        r#"
        INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, file_metadata_id, topic_id, thread_id, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', $9)
        "#,
    )
    .bind(id)
    .bind(chat_id)
    .bind(user_id)
    .bind(&req.content)
    .bind(&content_type)
    .bind(file_metadata_id)
    .bind(topic_id)
    .bind(thread_id)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    info!("send_message: message inserted, fetching back");

    let message = sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await
        .map_err(|e| {
            error!("send_message: failed to fetch message: {}", e);
            AppError::Database(e)
        })?;

    info!("send_message: message fetched successfully");

    // Publish event to Redis for SSE — publish to ALL participants' user channels
    let event = serde_json::json!({
        "type": "new_message",
        "chat_id": chat_id.to_string(),
        "data": MessageResponse::from(&message),
    });
    let event_str = event.to_string();

    // Get all participants and publish to each user's channel
    let participants: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM chat_participants WHERE chat_id = $1",
    )
    .bind(chat_id)
    .fetch_all(state.db.get_pool())
    .await?;

    // Check if this is the first message in the chat
    let message_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE chat_id = $1 AND deleted_at IS NULL",
    )
    .bind(chat_id)
    .fetch_one(state.db.get_pool())
    .await?;

    let is_first_message = message_count == 1;

    // If this is the first message, also send new_chat event to all participants
    if is_first_message {
        let chat = sqlx::query_as::<_, Chat>("SELECT * FROM chats WHERE id = $1")
            .bind(chat_id)
            .fetch_one(state.db.get_pool())
            .await?;

        let participant_ids: Vec<String> = sqlx::query_scalar(
            "SELECT user_id::text FROM chat_participants WHERE chat_id = $1",
        )
        .bind(chat_id)
        .fetch_all(state.db.get_pool())
        .await?;

        let mut chat_resp = ChatResponse::from(&chat);
        chat_resp.participants = participant_ids.clone();

        // For direct chats (not group, 2 participants), show the other user's name
        if !chat.is_group && participant_ids.len() == 2 {
            let other_user_id = participant_ids.iter()
                .find(|p| p.as_str() != user_id.to_string())
                .and_then(|p| Uuid::parse_str(p).ok());

            if let Some(other_id) = other_user_id {
                let username: Option<String> = sqlx::query_scalar(
                    "SELECT username FROM users WHERE id = $1"
                )
                .bind(other_id)
                .fetch_optional(state.db.get_pool())
                .await?;

                if let Some(name) = username {
                    chat_resp.name = Some(name);
                }
            }
        }

        let new_chat_event = serde_json::json!({
            "type": "new_chat",
            "data": chat_resp,
        });
        let new_chat_event_str = new_chat_event.to_string();

        for participant_id in &participants {
            let user_channel = format!("user:{}:events", participant_id);
            let result = state.redis.publish(&user_channel, &new_chat_event_str).await;
            tracing::info!("SSE publish new_chat to {}: {:?}", user_channel, result.as_ref().map(|_| "ok").map_err(|e| e.to_string()));
        }
    }

    for participant_id in &participants {
        let user_channel = format!("user:{}:events", participant_id);
        let result = state.redis.publish(&user_channel, &event_str).await;
        tracing::info!("SSE publish to {}: {:?}", user_channel, result.as_ref().map(|_| "ok").map_err(|e| e.to_string()));
    }

    // Increment unread counts for other participants
    sqlx::query(
        r#"
        INSERT INTO unread_counts (user_id, chat_id, count, last_message_at)
        SELECT cp.user_id, $1, 1, $2
        FROM chat_participants cp
        WHERE cp.chat_id = $1 AND cp.user_id != $3
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(chat_id)
    .bind(now)
    .bind(user_id)
    .execute(state.db.get_pool())
    .await?;

    // Update existing unread counts
    sqlx::query(
        r#"
        UPDATE unread_counts SET count = count + 1, last_message_at = $1
        WHERE user_id = $2 AND chat_id = $3
        "#,
    )
    .bind(now)
    .bind(user_id)
    .bind(chat_id)
    .execute(state.db.get_pool())
    .await?;

    // Send push notifications to other participants
    let participants: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM chat_participants WHERE chat_id = $1 AND user_id != $2",
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    for participant_id in &participants {
        let is_muted =
            crate::routes::push::is_chat_muted(&state, *participant_id, Some(chat_id), None)
                .await
                .unwrap_or(false);
        if !is_muted {
            let _ = crate::routes::push::send_push_notification(
                &state, *participant_id,
                "New message",
                "You have a new message",
                Some(&serde_json::json!({"chat_id": chat_id.to_string(), "message_id": id.to_string()}))
            ).await;
        }
    }

    Ok(Json(MessageResponse::from(&message)))
}

pub async fn edit_message(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::EditMessageRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let message_id: Uuid = id.parse().map_err(|_| AppError::MessageNotFound)?;

    let row: Option<(Option<Uuid>, Uuid)> =
        sqlx::query_as("SELECT sender_id, chat_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(state.db.get_pool())
            .await?;
    let (sender_id, chat_id) = row.ok_or(AppError::MessageNotFound)?;

    if sender_id != Some(user_id) {
        return Err(AppError::NotAuthorized);
    }

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    sqlx::query("UPDATE messages SET encrypted_content = $1, edited_at = NOW() WHERE id = $2")
        .bind(&req.content)
        .bind(message_id)
        .execute(state.db.get_pool())
        .await?;

    let message = sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_one(state.db.get_pool())
        .await?;

    Ok(Json(MessageResponse::from(&message)))
}

pub async fn delete_message(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let message_id: Uuid = id.parse().map_err(|_| AppError::MessageNotFound)?;

    let row: Option<(Option<Uuid>, Uuid)> =
        sqlx::query_as("SELECT sender_id, chat_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(state.db.get_pool())
            .await?;
    let (sender_id, _chat_id) = row.ok_or(AppError::MessageNotFound)?;

    if sender_id != Some(user_id) {
        return Err(AppError::NotAuthorized);
    }

    sqlx::query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
        .bind(message_id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(Ack {
        success: true,
        message: "Message deleted".to_string(),
    }))
}

pub async fn get_pinned_messages(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let pinned = sqlx::query_as::<_, PinnedMessage>(
        r#"
        SELECT pm.* FROM pinned_messages pm
        WHERE pm.chat_id = $1 AND (pm.user_id IS NULL OR pm.user_id = $2)
        ORDER BY pm.created_at DESC
        "#,
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    let mut result = Vec::new();
    for p in pinned {
        if let Some(msg) = sqlx::query_as::<_, Message>("SELECT * FROM messages WHERE id = $1")
            .bind(p.message_id)
            .fetch_optional(state.db.get_pool())
            .await?
        {
            result.push(serde_json::json!({
                "message": MessageResponse::from(&msg),
                "personal": p.user_id.is_some(),
            }));
        }
    }

    Ok(Json(result))
}

pub async fn pin_message(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let message_id: Uuid = body["message_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("message_id required".to_string()))?
        .parse()
        .map_err(|_| AppError::MessageNotFound)?;
    let personal = body
        .get("personal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let chat_id: Uuid = sqlx::query_scalar("SELECT chat_id FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::MessageNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let pinned_user_id = if personal { Some(user_id) } else { None };

    sqlx::query(
        "INSERT INTO pinned_messages (message_id, user_id, chat_id) VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id) DO NOTHING",
    )
    .bind(message_id)
    .bind(pinned_user_id)
    .bind(chat_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(Ack {
        success: true,
        message: "Message pinned".to_string(),
    }))
}

pub async fn unpin_message(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let message_id: Uuid = body["message_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("message_id required".to_string()))?
        .parse()
        .map_err(|_| AppError::MessageNotFound)?;
    let personal = body
        .get("personal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let chat_id: Uuid = sqlx::query_scalar("SELECT chat_id FROM messages WHERE id = $1")
        .bind(message_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::MessageNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let pinned_user_id = if personal { Some(user_id) } else { None };

    sqlx::query(
        "DELETE FROM pinned_messages WHERE message_id = $1 AND user_id IS NOT DISTINCT FROM $2",
    )
    .bind(message_id)
    .bind(pinned_user_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(Ack {
        success: true,
        message: "Message unpinned".to_string(),
    }))
}

pub async fn create_thread(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::CreateThreadRequest>,
) -> Result<Json<ThreadResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;
    let root_message_id: Uuid = req
        .root_message_id
        .parse()
        .map_err(|_| AppError::MessageNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let id = Uuid::new_v4();
    let now = Utc::now();

    sqlx::query(
        "INSERT INTO threads (id, chat_id, root_message_id, created_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(chat_id)
    .bind(root_message_id)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    let thread = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await?;

    Ok(Json(ThreadResponse {
        id: thread.id.to_string(),
        chat_id: thread.chat_id.to_string(),
        root_message_id: thread.root_message_id.to_string(),
        reply_count: 0,
        created_at: thread.created_at.to_rfc3339(),
    }))
}

pub async fn get_thread(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ThreadResponse>, AppError> {
    let thread_id: Uuid = id.parse().map_err(|_| AppError::MessageNotFound)?;

    let thread = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE id = $1")
        .bind(thread_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::MessageNotFound)?;

    let reply_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE thread_id = $1 AND deleted_at IS NULL",
    )
    .bind(thread_id)
    .fetch_one(state.db.get_pool())
    .await?;

    Ok(Json(ThreadResponse {
        id: thread.id.to_string(),
        chat_id: thread.chat_id.to_string(),
        root_message_id: thread.root_message_id.to_string(),
        reply_count: reply_count as i32,
        created_at: thread.created_at.to_rfc3339(),
    }))
}

pub async fn get_thread_messages(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<MessageResponse>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let thread_id: Uuid = id.parse().map_err(|_| AppError::MessageNotFound)?;

    let thread = sqlx::query_as::<_, Thread>("SELECT * FROM threads WHERE id = $1")
        .bind(thread_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::MessageNotFound)?;

    if !check_chat_participation(&state, thread.chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let messages = sqlx::query_as::<_, Message>(
        "SELECT * FROM messages WHERE thread_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC",
    )
    .bind(thread_id)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(messages.iter().map(MessageResponse::from).collect()))
}

pub async fn get_topics(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(params): Query<dto::GetTopicsQuery>,
) -> Result<Json<Vec<TopicResponse>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = params.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let topics = sqlx::query_as::<_, Topic>(
        "SELECT * FROM topics WHERE chat_id = $1 ORDER BY created_at DESC",
    )
    .bind(chat_id)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(
        topics
            .iter()
            .map(|t| TopicResponse {
                id: t.id.to_string(),
                chat_id: t.chat_id.to_string(),
                name: t.name.clone(),
                created_at: t.created_at.to_rfc3339(),
            })
            .collect(),
    ))
}

pub async fn create_topic(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<dto::CreateTopicRequest>,
) -> Result<Json<TopicResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let id = Uuid::new_v4();
    let now = Utc::now();

    sqlx::query(
        "INSERT INTO topics (id, chat_id, name, created_by, created_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(chat_id)
    .bind(&req.name)
    .bind(user_id)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    let topic = sqlx::query_as::<_, Topic>("SELECT * FROM topics WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await?;

    Ok(Json(TopicResponse {
        id: topic.id.to_string(),
        chat_id: topic.chat_id.to_string(),
        name: topic.name.clone(),
        created_at: topic.created_at.to_rfc3339(),
    }))
}

pub async fn send_typing(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = body["chat_id"]
        .as_str()
        .ok_or_else(|| AppError::Validation("chat_id required".to_string()))?
        .parse()
        .map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let event = serde_json::json!({
        "type": "typing",
        "user_id": user_id.to_string(),
        "chat_id": chat_id.to_string(),
    });
    let channel = format!("chat:{}:events", chat_id);
    let _ = state.redis.publish(&channel, &event.to_string()).await;

    Ok(Json(Ack {
        success: true,
        message: "Typing indicator sent".to_string(),
    }))
}

pub async fn mark_chat_read(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    sqlx::query(
        "UPDATE unread_counts SET count = 0, last_message_at = NOW() WHERE user_id = $1 AND chat_id = $2",
    )
    .bind(user_id)
    .bind(chat_id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(Ack {
        success: true,
        message: "Chat marked as read".to_string(),
    }))
}

pub async fn get_unread_counts(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let counts = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT chat_id, count FROM unread_counts WHERE user_id = $1 AND count > 0",
    )
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(
        counts
            .iter()
            .map(|(chat_id, count)| {
                serde_json::json!({
                    "chat_id": chat_id.to_string(),
                    "count": count,
                })
            })
            .collect(),
    ))
}

pub async fn get_chat_public_keys(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(chat_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    if !check_chat_participation(&state, chat_id, user_id).await? {
        return Err(AppError::NotAuthorized);
    }

    let keys: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        r#"
        SELECT u.id, u.public_key
        FROM users u
        JOIN chat_participants cp ON cp.user_id = u.id
        WHERE cp.chat_id = $1
        "#,
    )
    .bind(chat_id)
    .fetch_all(state.db.get_pool())
    .await?;

    let result: serde_json::Value = keys
        .into_iter()
        .filter_map(|(uid, key)| key.map(|k| (uid.to_string(), serde_json::Value::String(k))))
        .collect::<serde_json::Map<_, _>>()
        .into();

    Ok(Json(result))
}
