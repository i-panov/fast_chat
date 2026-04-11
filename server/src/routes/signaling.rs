use axum::{
    extract::{Path, State},
    http::{HeaderMap, header::AUTHORIZATION},
    Json,
};
use chrono::Utc;
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::call::ActiveCall,
    routes::dto::{Ack, CallResponse, CreateCallRequest},
    AppState,
};

pub async fn get_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth_header, &state.settings.jwt_secret)
}

pub async fn create_call(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<CreateCallRequest>,
) -> Result<Json<CallResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let id = Uuid::new_v4();
    let now = Utc::now();

    let chat_id = req.chat_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());
    let callee_id = req.callee_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());

    sqlx::query(
        "INSERT INTO active_calls (id, chat_id, caller_id, callee_id, status, started_at) VALUES ($1, $2, $3, $4, 'active', $5)",
    )
    .bind(id)
    .bind(chat_id)
    .bind(user_id)
    .bind(callee_id)
    .bind(now)
    .execute(state.db.get_pool())
    .await?;

    let call: ActiveCall = sqlx::query_as("SELECT * FROM active_calls WHERE id = $1")
        .bind(id)
        .fetch_one(state.db.get_pool())
        .await?;

    // Notify callee via SSE if 1:1 call
    if let Some(cid) = callee_id {
        let event = serde_json::json!({
            "type": "incoming_call",
            "data": CallResponse::from(&call),
        });
        let channel = format!("user:{}:events", cid);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    // Notify chat participants if group call
    if let Some(cid) = chat_id {
        let event = serde_json::json!({
            "type": "call_started",
            "data": CallResponse::from(&call),
        });
        let channel = format!("chat:{}:events", cid);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    Ok(Json(CallResponse::from(&call)))
}

pub async fn get_active_calls(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<CallResponse>>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let calls: Vec<ActiveCall> = sqlx::query_as(
        r#"
        SELECT ac.* FROM active_calls ac
        WHERE ac.status = 'active'
          AND (ac.caller_id = $1 OR ac.callee_id = $1
               OR ac.chat_id IN (
                   SELECT chat_id FROM chat_participants WHERE user_id = $1
               ))
        ORDER BY ac.started_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(state.db.get_pool())
    .await?;

    Ok(Json(calls.iter().map(CallResponse::from).collect()))
}

pub async fn accept_call(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<CallResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let id: Uuid = id.parse().map_err(|_| AppError::Validation("Invalid call ID".to_string()))?;

    sqlx::query("UPDATE active_calls SET status = 'active' WHERE id = $1")
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    let call: ActiveCall = sqlx::query_as("SELECT * FROM active_calls WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::Validation("Call not found".to_string()))?;

    // Notify caller
    if call.caller_id != user_id {
        let event = serde_json::json!({
            "type": "call_accepted",
            "data": CallResponse::from(&call),
        });
        let channel = format!("user:{}:events", call.caller_id);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    Ok(Json(CallResponse::from(&call)))
}

pub async fn reject_call(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let id: Uuid = id.parse().map_err(|_| AppError::Validation("Invalid call ID".to_string()))?;

    let call: ActiveCall = sqlx::query_as("SELECT * FROM active_calls WHERE id = $1")
        .bind(id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::Validation("Call not found".to_string()))?;

    sqlx::query("UPDATE active_calls SET status = 'rejected', ended_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    // Notify caller
    if call.caller_id != user_id {
        let event = serde_json::json!({
            "type": "call_rejected",
            "call_id": id.to_string(),
        });
        let channel = format!("user:{}:events", call.caller_id);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    Ok(Json(Ack { success: true, message: "Call rejected".to_string() }))
}

pub async fn end_call(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Ack>, AppError> {
    let _user_id = get_user_id(&headers, &state).await?;
    let id: Uuid = id.parse().map_err(|_| AppError::Validation("Invalid call ID".to_string()))?;

    sqlx::query("UPDATE active_calls SET status = 'ended', ended_at = NOW() WHERE id = $1 AND status = 'active'")
        .bind(id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(Ack { success: true, message: "Call ended".to_string() }))
}

pub async fn send_signal(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let call_id: Uuid = id.parse().map_err(|_| AppError::Validation("Invalid call ID".to_string()))?;

    let call: ActiveCall = sqlx::query_as("SELECT * FROM active_calls WHERE id = $1 AND status = 'active'")
        .bind(call_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::Validation("Call not found or not active".to_string()))?;

    let target_id = if call.caller_id == user_id {
        call.callee_id
    } else {
        Some(call.caller_id)
    };

    if let Some(target) = target_id {
        let event = serde_json::json!({
            "type": "signal",
            "call_id": call_id.to_string(),
            "from": user_id.to_string(),
            "data": body,
        });
        let channel = format!("user:{}:events", target);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    if let Some(chat_id) = call.chat_id {
        let event = serde_json::json!({
            "type": "signal",
            "call_id": call_id.to_string(),
            "from": user_id.to_string(),
            "data": body,
        });
        let channel = format!("chat:{}:events", chat_id);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    Ok(Json(Ack { success: true, message: "Signal sent".to_string() }))
}

pub async fn send_ice_candidate(
    State(state): State<std::sync::Arc<AppState>>,
    Path(call_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Ack>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let call_id: Uuid = call_id.parse().map_err(|_| AppError::Validation("Invalid call ID".to_string()))?;

    let call: ActiveCall = sqlx::query_as("SELECT * FROM active_calls WHERE id = $1 AND status = 'active'")
        .bind(call_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::Validation("Call not found or not active".to_string()))?;

    let target_id = if call.caller_id == user_id {
        call.callee_id
    } else {
        Some(call.caller_id)
    };

    if let Some(target) = target_id {
        let event = serde_json::json!({
            "type": "ice_candidate",
            "call_id": call_id.to_string(),
            "from": user_id.to_string(),
            "data": body,
        });
        let channel = format!("user:{}:events", target);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    if let Some(chat_id) = call.chat_id {
        let event = serde_json::json!({
            "type": "ice_candidate",
            "call_id": call_id.to_string(),
            "from": user_id.to_string(),
            "data": body,
        });
        let channel = format!("chat:{}:events", chat_id);
        let _ = state.redis.publish(&channel, &event.to_string()).await;
    }

    Ok(Json(Ack { success: true, message: "ICE candidate sent".to_string() }))
}

impl From<&ActiveCall> for CallResponse {
    fn from(call: &ActiveCall) -> Self {
        Self {
            id: call.id.to_string(),
            chat_id: call.chat_id.map(|id: Uuid| id.to_string()),
            caller_id: call.caller_id.to_string(),
            callee_id: call.callee_id.map(|id: Uuid| id.to_string()),
            status: call.status.clone(),
            started_at: call.started_at.to_rfc3339(),
        }
    }
}
