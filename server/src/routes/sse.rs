use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap},
    response::sse::{Event, KeepAlive},
};
use futures::stream::Stream;
use std::convert::Infallible;
use std::time::Duration;

use crate::{error::AppError, middleware::jwt::get_user_id_from_request, AppState};

pub async fn sse_handler(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v: &axum::http::HeaderValue| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;

    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    // Subscribe to user's Redis channel
    let channel = format!("user:{}:events", user_id);
    let mut subscriber = state.redis.subscribe(&channel).await?;

    let stream = async_stream::stream! {
        // Send initial connected event
        yield Ok(Event::default().event("connected").data("connected"));

        // Listen for Redis pub/sub messages
        while let Ok(msg) = subscriber.recv().await {
            tracing::info!("SSE received from Redis: {}", msg);
            // Try to parse as JSON event
            if let Ok(event_data) = serde_json::from_str::<serde_json::Value>(&msg) {
                // Support both "type" and "event" field names
                let event_type = event_data.get("type")
                    .or_else(|| event_data.get("event"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("message");

                // Serialize the entire payload as data
                let data = serde_json::to_string(&event_data).unwrap_or_default();
                tracing::info!("SSE yielding event: type={}, data_len={}", event_type, data.len());
                yield Ok(Event::default().event(event_type).data(&data));
            } else {
                // Plain text message
                yield Ok(Event::default().event("message").data(&msg));
            }
        }
    };

    Ok(axum::response::Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}
