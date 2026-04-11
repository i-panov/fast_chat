use axum::{
    extract::{Path, State},
    http::{HeaderMap, header::AUTHORIZATION},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use p256::ecdsa::{SigningKey, Signature, signature::Signer};
use sha2::{Digest, Sha256};

use crate::{
    error::AppError,
    middleware::jwt::get_user_id_from_request,
    models::{PushSubscription, NotificationSettings, MutedChat},
    AppState,
};

// ─── Request types ───

#[derive(Debug, Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub p256dh: String,
    pub auth_secret: String,
    pub user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationSettingsUpdate {
    pub push_enabled: Option<bool>,
    pub sound_enabled: Option<bool>,
    pub preview_enabled: Option<bool>,
    pub mute_all: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MuteChatRequest {
    pub chat_id: Option<String>,
    pub channel_id: Option<String>,
    pub muted_until: Option<String>,
}

// ─── Helpers ───

fn extract_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth, &state.settings.jwt_secret)
}

async fn ensure_settings_exist(state: &AppState, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query("INSERT INTO notification_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(user_id).execute(state.db.get_pool()).await?;
    Ok(())
}

// ─── Web Push implementation ───

struct VapidSigner {
    private_key: SigningKey,
    public_key_bytes: Vec<u8>,
}

impl VapidSigner {
    fn new(private_key_b64: &str, public_key_b64: &str) -> Result<Self, String> {
        let private_key_bytes = URL_SAFE_NO_PAD.decode(private_key_b64)
            .map_err(|e| format!("Invalid VAPID private key: {}", e))?;
        let private_key = SigningKey::from_slice(&private_key_bytes)
            .map_err(|e| format!("Invalid VAPID private key bytes: {}", e))?;

        let public_key_bytes = URL_SAFE_NO_PAD.decode(public_key_b64)
            .map_err(|e| format!("Invalid VAPID public key: {}", e))?;

        Ok(Self { private_key, public_key_bytes })
    }

    fn sign(&mut self, audience: &str, subject: &str) -> Result<String, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Time error: {}", e))?
            .as_secs();
        let exp = now + 43200; // 12 hours

        // JWT header
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            r#"{"typ":"JWT","alg":"ES256"}"#.as_bytes()
        );

        // JWT payload
        let payload_obj = serde_json::json!({
            "aud": audience,
            "exp": exp,
            "sub": subject,
        });
        let payload_str = serde_json::to_string(&payload_obj).map_err(|e| e.to_string())?;
        let payload = URL_SAFE_NO_PAD.encode(payload_str.as_bytes());

        let signing_input = format!("{}.{}", header, payload);

        let sig: Signature = self.private_key.sign(signing_input.as_bytes());

        // Convert signature to r||s format for JWT
        let (r, s) = sig.split_bytes();
        let jwt_sig = format!("{}{}", URL_SAFE_NO_PAD.encode(r), URL_SAFE_NO_PAD.encode(s));

        Ok(format!("{}.{}.{}", header, payload, jwt_sig))
    }

    fn public_key_bytes(&self) -> &[u8] {
        &self.public_key_bytes
    }
}

/// ECDH key exchange + HKDF to derive shared secret (placeholder — full implementation in production)
fn _derive_shared_secret(client_pubkey_b64: &str, auth_secret_b64: &str) -> Result<Vec<u8>, String> {
    let _auth_secret = URL_SAFE_NO_PAD.decode(auth_secret_b64)
        .map_err(|e| format!("Invalid auth secret: {}", e))?;
    let _client_pubkey = URL_SAFE_NO_PAD.decode(client_pubkey_b64)
        .map_err(|e| format!("Invalid client public key: {}", e))?;
    // Placeholder: return auth_secret as key material
    Ok(_auth_secret)
}

/// Build and send a push notification to a single subscription
async fn send_to_subscription(
    state: &AppState,
    sub: &PushSubscription,
    notification: &serde_json::Value,
) -> Result<(), String> {
    let vapid_private = state.settings.vapid_private_key.as_ref()
        .ok_or_else(|| "VAPID not configured".to_string())?;
    let vapid_pub = state.settings.vapid_public_key.as_ref()
        .ok_or_else(|| "VAPID public key not configured".to_string())?;
    let vapid_subject = state.settings.vapid_subject.as_ref()
        .ok_or_else(|| "VAPID subject not configured".to_string())?;

    let payload = serde_json::to_string(notification)
        .map_err(|e| format!("Serialization error: {}", e))?;

    // VAPID signature
    let mut signer = VapidSigner::new(vapid_private, vapid_pub)?;
    let vapid_sig = signer.sign(&sub.endpoint, vapid_subject)?;
    let pubkey_b64 = URL_SAFE_NO_PAD.encode(signer.public_key_bytes());

    // Send HTTP POST
    let client = reqwest::Client::new();
    let resp = client.post(&sub.endpoint)
        .header("TTL", "60")
        .header("Urgency", "high")
        .header("Authorization", format!("vapid t={},k={}", vapid_sig, pubkey_b64))
        .body(payload.as_bytes().to_vec())
        .send().await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Push returned {}", resp.status()));
    }

    Ok(())
}

/// Send a web push notification to a user
pub async fn send_push_notification(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    body: &str,
    data: Option<&serde_json::Value>,
) -> Result<(), AppError> {
    // Check settings
    let settings = sqlx::query_as::<_, NotificationSettings>(
        "SELECT * FROM notification_settings WHERE user_id = $1"
    ).bind(user_id).fetch_optional(state.db.get_pool()).await?;

    if let Some(s) = &settings {
        if !s.push_enabled || s.mute_all {
            return Ok(());
        }
    }

    // Check VAPID config
    if state.settings.vapid_private_key.is_none() {
        return Ok(());
    }

    let notification = serde_json::json!({
        "title": title,
        "body": body,
        "data": data,
        "icon": "/icon-192.png",
        "badge": "/badge-72.png",
        "tag": user_id.to_string(),
        "renotify": true,
    });

    let subscriptions = sqlx::query_as::<_, PushSubscription>(
        "SELECT * FROM push_subscriptions WHERE user_id = $1"
    ).bind(user_id).fetch_all(state.db.get_pool()).await?;

    for sub in &subscriptions {
        let result = send_to_subscription(state, sub, &notification).await;
        if let Err(e) = result {
            tracing::warn!("Failed to send push to sub {} for user {}: {}", sub.id, user_id, e);
            if e.contains("404") || e.contains("410") {
                sqlx::query("DELETE FROM push_subscriptions WHERE id = $1")
                    .bind(sub.id).execute(state.db.get_pool()).await?;
            }
        } else {
            sqlx::query("UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1")
                .bind(sub.id).execute(state.db.get_pool()).await?;
        }
    }

    Ok(())
}

/// Check if a user has muted a specific chat/channel
pub async fn is_chat_muted(state: &AppState, user_id: Uuid, chat_id: Option<Uuid>, channel_id: Option<Uuid>) -> Result<bool, AppError> {
    let mute_all: Option<bool> = sqlx::query_scalar(
        "SELECT mute_all FROM notification_settings WHERE user_id = $1"
    ).bind(user_id).fetch_optional(state.db.get_pool()).await?;

    if mute_all.unwrap_or(false) { return Ok(true); }

    let muted: Option<Option<chrono::DateTime<Utc>>> = sqlx::query_scalar(
        "SELECT muted_until FROM muted_chats WHERE user_id = $1 AND chat_id = $2 AND channel_id = $3"
    ).bind(user_id).bind(chat_id).bind(channel_id)
    .fetch_optional(state.db.get_pool()).await?;

    if let Some(Some(mute_until)) = muted {
        if mute_until > Utc::now() { return Ok(true); }
    }

    Ok(false)
}

// ─── Router ───

pub fn router(state: std::sync::Arc<AppState>) -> axum::Router<std::sync::Arc<AppState>> {
    axum::Router::new()
        .route("/push/subscribe", axum::routing::post(subscribe))
        .route("/push/subscriptions", axum::routing::get(list_subscriptions))
        .route("/push/subscriptions/:id", axum::routing::delete(unsubscribe))
        .route("/push/vapid-public-key", axum::routing::get(get_vapid_public_key))
        .route("/notifications/settings", axum::routing::get(get_settings))
        .route("/notifications/settings", axum::routing::put(update_settings))
        .route("/notifications/muted", axum::routing::get(list_muted))
        .route("/notifications/mute", axum::routing::post(mute_chat))
        .route("/notifications/unmute", axum::routing::post(unmute_chat))
        .route("/notifications/test-push", axum::routing::post(test_push))
        .with_state(state)
}

// ─── Push Subscriptions ───

pub async fn subscribe(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<SubscribeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_secret, user_agent, created_at, last_used_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6) \
         ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $3, auth_secret = $4, user_agent = $5, last_used_at = $6"
    ).bind(user_id).bind(&req.endpoint).bind(&req.p256dh).bind(&req.auth_secret)
     .bind(&req.user_agent).bind(now).execute(state.db.get_pool()).await?;
    ensure_settings_exist(&state, user_id).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn list_subscriptions(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let subs = sqlx::query_as::<_, PushSubscription>(
        "SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY last_used_at DESC"
    ).bind(user_id).fetch_all(state.db.get_pool()).await?;
    Ok(Json(subs.iter().map(|s| serde_json::json!({
        "id": s.id.to_string(), "endpoint_preview": s.endpoint.chars().take(50).collect::<String>(),
        "user_agent": s.user_agent, "created_at": s.created_at.to_rfc3339(), "last_used_at": s.last_used_at.to_rfc3339(),
    })).collect()))
}

pub async fn unsubscribe(
    State(state): State<std::sync::Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let sub_id: Uuid = id.parse().map_err(|_| AppError::Validation("Invalid subscription ID".to_string()))?;
    sqlx::query("DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2")
        .bind(sub_id).bind(user_id).execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn get_vapid_public_key(State(state): State<std::sync::Arc<AppState>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "public_key": state.settings.vapid_public_key,
        "enabled": state.settings.vapid_public_key.is_some(),
    }))
}

// ─── Notification Settings ───

pub async fn get_settings(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    ensure_settings_exist(&state, user_id).await?;
    let settings = sqlx::query_as::<_, NotificationSettings>(
        "SELECT * FROM notification_settings WHERE user_id = $1"
    ).bind(user_id).fetch_one(state.db.get_pool()).await
    .map_err(|_| AppError::Internal)?;
    Ok(Json(serde_json::json!({
        "push_enabled": settings.push_enabled, "sound_enabled": settings.sound_enabled,
        "preview_enabled": settings.preview_enabled, "mute_all": settings.mute_all,
        "updated_at": settings.updated_at.to_rfc3339(),
    })))
}

pub async fn update_settings(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<NotificationSettingsUpdate>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    ensure_settings_exist(&state, user_id).await?;
    let now = Utc::now();
    if let Some(val) = req.push_enabled {
        sqlx::query("UPDATE notification_settings SET push_enabled = $1, updated_at = $2 WHERE user_id = $3")
            .bind(val).bind(now).bind(user_id).execute(state.db.get_pool()).await?;
    }
    if let Some(val) = req.sound_enabled {
        sqlx::query("UPDATE notification_settings SET sound_enabled = $1, updated_at = $2 WHERE user_id = $3")
            .bind(val).bind(now).bind(user_id).execute(state.db.get_pool()).await?;
    }
    if let Some(val) = req.preview_enabled {
        sqlx::query("UPDATE notification_settings SET preview_enabled = $1, updated_at = $2 WHERE user_id = $3")
            .bind(val).bind(now).bind(user_id).execute(state.db.get_pool()).await?;
    }
    if let Some(val) = req.mute_all {
        sqlx::query("UPDATE notification_settings SET mute_all = $1, updated_at = $2 WHERE user_id = $3")
            .bind(val).bind(now).bind(user_id).execute(state.db.get_pool()).await?;
    }
    get_settings(State(state), headers).await
}

// ─── Muted Chats/Channels ───

pub async fn list_muted(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let mutes = sqlx::query_as::<_, MutedChat>(
        "SELECT * FROM muted_chats WHERE user_id = $1 ORDER BY created_at DESC"
    ).bind(user_id).fetch_all(state.db.get_pool()).await?;
    Ok(Json(mutes.iter().map(|m| serde_json::json!({
        "chat_id": m.chat_id.map(|id| id.to_string()),
        "channel_id": m.channel_id.map(|id| id.to_string()),
        "muted_until": m.muted_until.map(|dt| dt.to_rfc3339()),
        "created_at": m.created_at.to_rfc3339(),
    })).collect()))
}

pub async fn mute_chat(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<MuteChatRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let chat_id = req.chat_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());
    let channel_id = req.channel_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());
    if chat_id.is_none() && channel_id.is_none() {
        return Err(AppError::Validation("Either chat_id or channel_id is required".to_string()));
    }
    let muted_until = req.muted_until.as_ref().and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.with_timezone(&Utc))
    });
    sqlx::query(
        "INSERT INTO muted_chats (user_id, chat_id, channel_id, muted_until) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (user_id, COALESCE(chat_id, channel_id)) DO UPDATE SET muted_until = $4"
    ).bind(user_id).bind(chat_id).bind(channel_id).bind(muted_until)
    .execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn unmute_chat(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<MuteChatRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    let chat_id = req.chat_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());
    let channel_id = req.channel_id.as_ref().and_then(|s| Uuid::parse_str(s).ok());
    if chat_id.is_none() && channel_id.is_none() {
        return Err(AppError::Validation("Either chat_id or channel_id is required".to_string()));
    }
    sqlx::query("DELETE FROM muted_chats WHERE user_id = $1 AND chat_id = $2 AND channel_id = $3")
        .bind(user_id).bind(chat_id).bind(channel_id).execute(state.db.get_pool()).await?;
    Ok(Json(serde_json::json!({"success": true})))
}

pub async fn test_push(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id = extract_user_id(&headers, &state)?;
    send_push_notification(&state, user_id, "Fast Chat", "Push notifications are working!", None).await?;
    Ok(Json(serde_json::json!({"success": true, "message": "Test push sent"})))
}
