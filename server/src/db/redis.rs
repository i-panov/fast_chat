use futures::StreamExt;
use redis::aio::ConnectionManager;
use redis::{AsyncCommands, Client};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct RedisPool {
    manager: ConnectionManager,
    redis_url: String,
}

impl RedisPool {
    pub async fn new(redis_url: &str) -> Result<Self, redis::RedisError> {
        let client = Client::open(redis_url)?;
        let manager = ConnectionManager::new(client).await?;
        Ok(Self {
            manager,
            redis_url: redis_url.to_string(),
        })
    }

    /// Create a fresh ConnectionManager (used for reconnection)
    async fn recreate_manager(&self) -> Result<ConnectionManager, redis::RedisError> {
        let client = Client::open(self.redis_url.as_str())?;
        ConnectionManager::new(client).await
    }

    pub async fn publish(&self, channel: &str, message: &str) -> Result<(), redis::RedisError> {
        // ConnectionManager handles reconnection internally, but if it fails completely,
        // try to recreate the connection
        let mut manager = self.manager.clone();
        match manager.publish::<_, _, ()>(channel, message).await {
            Ok(_) => Ok(()),
            Err(e) => {
                tracing::warn!("Redis publish failed, attempting reconnect: {}", e);
                match self.recreate_manager().await {
                    Ok(new_manager) => {
                        // Note: We can't replace self.manager since it's not behind a lock.
                        // ConnectionManager clone shares the underlying connection,
                        // so creating a new one effectively gives us a fresh connection.
                        // For a more robust solution, consider using a swap-able wrapper.
                        let mut new_mgr = new_manager;
                        new_mgr.publish::<_, _, ()>(channel, message).await
                    }
                    Err(reconnect_err) => {
                        tracing::error!("Redis reconnect failed: {}", reconnect_err);
                        Err(reconnect_err)
                    }
                }
            }
        }
    }

    pub async fn subscribe(&self, channel: &str) -> Result<broadcast::Receiver<String>, redis::RedisError> {
        let client = Client::open(self.redis_url.as_str())?;
        let mut pubsub = client.get_async_pubsub().await?;

        pubsub.subscribe(channel).await?;

        let (tx, rx) = broadcast::channel(100);
        let channel_name = channel.to_string();

        tokio::spawn(async move {
            let mut stream = pubsub.on_message();
            while let Some(msg) = stream.next().await {
                if let Ok(payload) = msg.get_payload::<String>() {
                    if tx.send(payload).is_err() {
                        // All receivers dropped, exit the loop
                        break;
                    }
                }
            }
            tracing::debug!("Redis pubsub stream ended for channel: {}", channel_name);
        });

        Ok(rx)
    }
}
