pub mod admin;
pub mod auth;
pub mod bots;
pub mod channels;
pub mod dto;
pub mod files;
pub mod messaging;
pub mod push;
pub mod signaling;
pub mod sse;
pub mod users;

use axum::{middleware::from_fn_with_state, routing, Router};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::{middleware::jwt::jwt_auth, AppState};

pub fn create_router(state: Arc<AppState>) -> Router {
    let cors = if state.settings.allowed_origins.is_empty() {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<_> = state
            .settings
            .allowed_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    // ─── Public routes (no JWT required) ───
    let public = Router::new()
        .route("/health", routing::get(health_check))
        .route("/auth/request-code", routing::post(auth::request_code))
        .route("/auth/verify-code", routing::post(auth::verify_code))
        .route("/auth/verify-2fa", routing::post(auth::verify_2fa))
        .route("/auth/refresh", routing::post(auth::refresh_token))
        // 2FA setup — accepts user_id in body (no JWT needed for initial setup)
        .route("/auth/2fa/setup", routing::post(auth::setup_2fa))
        .route(
            "/auth/2fa/verify-setup",
            routing::post(auth::verify_2fa_setup),
        )
        .route("/auth/2fa/enable", routing::post(auth::enable_2fa));

    // ─── Protected routes (JWT required) ───
    let protected = Router::new()
        .route("/auth/me", routing::get(auth::get_current_user))
        .route("/auth/2fa/disable", routing::post(auth::disable_2fa))
        .route(
            "/auth/2fa/backup-codes",
            routing::get(auth::get_backup_codes),
        )
        .route(
            "/auth/2fa/backup-codes/regenerate",
            routing::post(auth::regenerate_backup_codes),
        )
        .route(
            "/users",
            routing::get(users::list_users).post(users::create_user),
        )
        .route("/users/search", routing::get(users::search_users))
        .route(
            "/users/{id}",
            routing::get(users::get_user)
                .put(users::update_user)
                .delete(users::delete_user),
        )
        .route("/users/{id}/admin", routing::put(users::set_admin))
        .route("/users/{id}/disable", routing::put(users::set_disabled))
        .route(
            "/chats",
            routing::get(messaging::get_chats).post(messaging::create_chat),
        )
        .route(
            "/chats/{id}",
            routing::get(messaging::get_chat),
        )
        .route("/chats/{id}/hide", routing::post(messaging::hide_chat))
        .route(
            "/chats/{chat_id}/messages",
            routing::get(messaging::get_messages),
        )
        .route("/messages", routing::post(messaging::send_message))
        .route("/messages/{id}", routing::put(messaging::edit_message))
        .route("/messages/{id}", routing::delete(messaging::delete_message))
        .route(
            "/chats/{chat_id}/pins",
            routing::get(messaging::get_pinned_messages),
        )
        .route("/pins", routing::post(messaging::pin_message))
        .route("/pins", routing::delete(messaging::unpin_message))
        .route("/threads", routing::post(messaging::create_thread))
        .route("/threads/{id}", routing::get(messaging::get_thread))
        .route(
            "/threads/{id}/messages",
            routing::get(messaging::get_thread_messages),
        )
        .route(
            "/topics",
            routing::get(messaging::get_topics).post(messaging::create_topic),
        )
        .route("/typing", routing::post(messaging::send_typing))
        .route(
            "/chats/{chat_id}/read",
            routing::post(messaging::mark_chat_read),
        )
        .route("/unread", routing::get(messaging::get_unread_counts))
        .route("/files/upload", routing::post(files::upload_file))
        .route(
            "/files/upload-chat/{chat_id}",
            routing::post(files::upload_file_for_chat),
        )
        .route("/files/{id}", routing::get(files::download_file))
        .route("/files/{id}/meta", routing::get(files::get_file_meta))
        .route("/calls", routing::post(signaling::create_call))
        .route("/calls/active", routing::get(signaling::get_active_calls))
        .route("/calls/{id}/accept", routing::post(signaling::accept_call))
        .route("/calls/{id}/reject", routing::post(signaling::reject_call))
        .route("/calls/{id}/end", routing::post(signaling::end_call))
        .route("/calls/{id}/signal", routing::post(signaling::send_signal))
        .route(
            "/calls/ice/{call_id}",
            routing::post(signaling::send_ice_candidate),
        )
        .route("/sse/connect", routing::get(sse::sse_handler))
        .route("/stats", routing::get(stats_check))
        .route("/admin/health", routing::get(admin::health_check))
        .route(
            "/admin/settings",
            routing::get(admin::get_settings).put(admin::update_settings),
        )
        .route(
            "/admin/settings/{key}",
            routing::put(admin::update_setting_key),
        )
        // Bot management (JWT protected)
        .route(
            "/bots",
            routing::post(bots::create_bot).get(bots::list_bots),
        )
        .route(
            "/bots/{id}",
            routing::get(bots::get_bot)
                .put(bots::update_bot)
                .delete(bots::delete_bot),
        )
        .route("/bots/{id}/token", routing::post(bots::regenerate_token))
        .route(
            "/bots/{id}/webhook",
            routing::put(bots::set_webhook).delete(bots::delete_webhook),
        )
        .route(
            "/bots/{id}/commands",
            routing::get(bots::list_commands).post(bots::register_command),
        )
        .route(
            "/bots/{id}/commands/{cmd}",
            routing::delete(bots::delete_command),
        )
        .route(
            "/bots/{id}/chats",
            routing::get(bots::list_bot_chats).post(bots::add_to_chat),
        )
        .route(
            "/bots/{id}/chats/{chat_id}",
            routing::delete(bots::remove_from_chat),
        )
        // Channels (JWT protected)
        .route(
            "/channels",
            routing::post(channels::create_channel).get(channels::list_channels),
        )
        .route("/channels/search", routing::get(channels::search_channels))
        .route(
            "/channels/{id}",
            routing::get(channels::get_channel)
                .put(channels::update_channel)
                .delete(channels::delete_channel),
        )
        .route(
            "/channels/{id}/messages",
            routing::post(channels::send_message).get(channels::get_messages),
        )
        .route(
            "/channels/{id}/subscribe",
            routing::post(channels::subscribe),
        )
        .route(
            "/channels/{id}/unsubscribe",
            routing::post(channels::unsubscribe),
        )
        .route(
            "/channels/{id}/subscribers",
            routing::get(channels::list_subscribers),
        )
        .route(
            "/channels/{id}/subscribers/{user_id}",
            routing::delete(channels::remove_subscriber),
        )
        .route(
            "/channels/{id}/requests",
            routing::get(channels::list_requests),
        )
        .route(
            "/channels/{id}/requests/{user_id}/approve",
            routing::post(channels::approve_request),
        )
        .route(
            "/channels/{id}/requests/{user_id}/reject",
            routing::post(channels::reject_request),
        )
        // Push notifications
        .route("/push/subscribe", routing::post(push::subscribe))
        .route(
            "/push/subscriptions",
            routing::get(push::list_subscriptions),
        )
        .route(
            "/push/subscriptions/{id}",
            routing::delete(push::unsubscribe),
        )
        .route(
            "/push/vapid-public-key",
            routing::get(push::get_vapid_public_key),
        )
        .route(
            "/notifications/settings",
            routing::get(push::get_settings).put(push::update_settings),
        )
        .route("/notifications/muted", routing::get(push::list_muted))
        .route("/notifications/mute", routing::post(push::mute_chat))
        .route("/notifications/unmute", routing::post(push::unmute_chat))
        .route("/notifications/test-push", routing::post(push::test_push))
        .route_layer(from_fn_with_state(state.clone(), jwt_auth));

    // Bot API (token auth — no JWT)
    let bot_api = Router::new()
        .route("/me", routing::get(bots::bot_api_me))
        .route("/updates", routing::get(bots::bot_api_get_updates))
        .route("/send-message", routing::post(bots::bot_api_send_message));

    Router::new()
        .nest("/api", Router::new().merge(public).merge(protected))
        .nest("/api/bot-api", bot_api)
        .layer(cors)
        .with_state(state)
}

async fn health_check(state: axum::extract::State<Arc<AppState>>) -> axum::Json<serde_json::Value> {
    let db_healthy = sqlx::query("SELECT 1")
        .fetch_one(state.db.get_pool())
        .await
        .is_ok();

    axum::Json(serde_json::json!({
        "status": if db_healthy { "ok" } else { "degraded" },
        "database": if db_healthy { "connected" } else { "disconnected" },
    }))
}

async fn stats_check(state: axum::extract::State<Arc<AppState>>) -> axum::Json<serde_json::Value> {
    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(state.db.get_pool())
        .await
        .unwrap_or(0);

    let chat_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chats")
        .fetch_one(state.db.get_pool())
        .await
        .unwrap_or(0);

    axum::Json(serde_json::json!({
        "users": user_count,
        "chats": chat_count,
    }))
}
