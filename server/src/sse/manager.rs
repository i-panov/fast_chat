use axum::response::sse::Event;
use dashmap::DashMap;
use futures::stream::Stream;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use std::convert::Infallible;

use crate::db::redis::RedisPool;
use crate::error::AppError;

/// SSE connection for a single user
struct SseConnection {
    tx: mpsc::Sender<Result<Event, Infallible>>,
}

type Connections = Arc<DashMap<uuid::Uuid, SseConnection>>;

/// Manages SSE connections and broadcasts events via Redis pub/sub
pub struct SseManager {
    connections: Connections,
    redis: RedisPool,
}

impl SseManager {
    pub fn new(redis: RedisPool) -> Self {
        Self {
            connections: Arc::new(DashMap::new()),
            redis,
        }
    }

    /// Subscribe a user to their SSE channel and return a stream of events
    pub async fn subscribe(&self, user_id: uuid::Uuid) -> impl Stream<Item = Result<Event, Infallible>> {
        let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(100);

        // Send initial connection event
        let _ = tx.send(Ok(Event::default().data("connected"))).await;

        self.connections.insert(user_id, SseConnection { tx });

        // Subscribe to user's Redis channel
        let redis = self.redis.clone();
        let connections = self.connections.clone();
        let channel = format!("user:{}:events", user_id);

        // Spawn task to listen on Redis pub/sub and forward to SSE
        tokio::spawn(async move {
            match redis.subscribe(&channel).await {
                Ok(mut subscriber) => {
                    while let Ok(msg) = subscriber.recv().await {
                        let event = Event::default()
                            .event("message")
                            .data(&msg);

                        if let Some(entry) = connections.get(&user_id) {
                            if entry.tx.send(Ok(event)).await.is_err() {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to subscribe to Redis channel {}: {}", channel, e);
                }
            }
        });

        ReceiverStream::new(rx)
    }

    /// Broadcast an event to all users in a chat
    pub async fn broadcast_to_chat(
        &self,
        chat_id: uuid::Uuid,
        event: &str,
        data: &str,
    ) -> Result<(), AppError> {
        let channel = format!("chat:{}:events", chat_id);
        let payload = serde_json::json!({
            "event": event,
            "data": data,
        });
        self.redis.publish(&channel, &payload.to_string()).await?;
        Ok(())
    }

    /// Send an event to a specific user
    pub async fn send_to_user(
        &self,
        user_id: uuid::Uuid,
        event: &str,
        data: &str,
    ) -> Result<(), AppError> {
        let channel = format!("user:{}:events", user_id);
        let payload = serde_json::json!({
            "event": event,
            "data": data,
        });
        self.redis.publish(&channel, &payload.to_string()).await?;
        Ok(())
    }

    /// Remove a disconnected user
    pub fn remove_connection(&self, user_id: &uuid::Uuid) {
        self.connections.remove(user_id);
    }
}
