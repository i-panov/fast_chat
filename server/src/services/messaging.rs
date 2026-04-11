use std::sync::Arc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::middleware::{check_chat_participation, get_user_id_from_request};
use crate::proto::common::{Ack, Empty};
use crate::proto::messaging::{
    Chat as ProtoChat, CreateChatRequest, CreateThreadRequest, CreateTopicRequest,
    DeleteMessageRequest, EditMessageRequest, GetMessagesRequest, GetPinnedMessagesRequest,
    GetPinnedMessagesResponse, GetThreadMessagesRequest, GetThreadRequest, GetTopicsRequest,
    MarkChatReadRequest, MarkMessageReadRequest, Message as ProtoMessage, MessagesPage,
    PinMessageRequest, PinnedMessage as ProtoPinnedMessage, SendMessageRequest, SendTypingRequest,
    StreamRequest, StreamingMessage, Thread, Topic, TopicsResponse, UnpinMessageRequest,
};
use crate::{error::AppError, AppState};
use serde::{Deserialize, Serialize};

/// Unified pub/sub event type for chat channels
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum ChatPubSubEvent {
    #[serde(rename = "message")]
    Message {
        id: String,
        chat_id: String,
        sender_id: String,
        encrypted_content: String,
        content_type: String,
        file_metadata_id: String,
        status: String,
        edited: bool,
        deleted: bool,
        created_at: String,
        edited_at: String,
        topic_id: String,
        thread_id: String,
    },
    #[serde(rename = "typing")]
    Typing { chat_id: String, user_id: String },
    #[serde(rename = "read_receipt")]
    ReadReceipt {
        chat_id: String,
        reader_id: String,
        message_id: String,
    },
}

pub struct MessagingService {
    state: Arc<AppState>,
}

impl MessagingService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn chat_to_proto(&self, chat: &crate::models::Chat) -> ProtoChat {
        ProtoChat {
            id: chat.id.to_string(),
            is_group: chat.is_group,
            name: chat.name.clone().unwrap_or_default(),
            participants: vec![],
            created_at: chat.created_at.to_rfc3339(),
            created_by: chat.created_by.to_string(),
            is_favorites: chat.is_favorites,
        }
    }

    fn message_to_proto(&self, msg: &crate::models::Message) -> ProtoMessage {
        ProtoMessage {
            id: msg.id.to_string(),
            chat_id: msg.chat_id.to_string(),
            sender_id: msg.sender_id.to_string(),
            encrypted_content: msg.encrypted_content.clone(),
            content_type: msg.content_type.clone(),
            file_metadata_id: msg
                .file_metadata_id
                .map(|id| id.to_string())
                .unwrap_or_default(),
            status: msg.status.clone(),
            edited: msg.edited_at.is_some(),
            deleted: msg.deleted_at.is_some(),
            created_at: msg.created_at.to_rfc3339(),
            edited_at: msg.edited_at.map(|dt| dt.to_rfc3339()).unwrap_or_default(),
            topic_id: msg.topic_id.map(|id| id.to_string()).unwrap_or_default(),
            thread_id: msg.thread_id.map(|id| id.to_string()).unwrap_or_default(),
        }
    }

    fn thread_to_proto(&self, thread: &crate::models::Thread, reply_count: i64) -> Thread {
        Thread {
            id: thread.id.to_string(),
            chat_id: thread.chat_id.to_string(),
            root_message_id: thread.root_message_id.to_string(),
            reply_count: reply_count as i32,
            created_at: thread.created_at.to_rfc3339(),
        }
    }

    fn topic_to_proto(&self, topic: &crate::models::Topic) -> Topic {
        Topic {
            id: topic.id.to_string(),
            chat_id: topic.chat_id.to_string(),
            name: topic.name.clone(),
            created_at: topic.created_at.to_rfc3339(),
        }
    }
}

#[tonic::async_trait]
impl crate::proto::messaging::messaging_server::Messaging for MessagingService {
    async fn create_chat(
        &self,
        request: Request<CreateChatRequest>,
    ) -> Result<Response<ProtoChat>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let id = Uuid::new_v4();
        let now = chrono::Utc::now();

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
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        sqlx::query("INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)")
            .bind(id)
            .bind(user_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        for participant_id in &req.participants {
            if let Ok(pid) = Uuid::parse_str(participant_id) {
                sqlx::query("INSERT INTO chat_participants (chat_id, user_id) VALUES ($1, $2)")
                    .bind(id)
                    .bind(pid)
                    .execute(self.state.db.get_pool())
                    .await
                    .map_err(AppError::from)?;
            }
        }

        let chat = sqlx::query_as::<_, crate::models::Chat>("SELECT * FROM chats WHERE id = $1")
            .bind(id)
            .fetch_one(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(self.chat_to_proto(&chat)))
    }

    type GetChatsStream = tokio_stream::wrappers::ReceiverStream<Result<ProtoChat, Status>>;

    async fn get_chats(
        &self,
        request: Request<Empty>,
    ) -> Result<Response<Self::GetChatsStream>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let db_pool = self.state.db.get_pool().clone();

        let chats = sqlx::query_as::<_, crate::models::Chat>(
            r#"
            SELECT c.* FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE cp.user_id = $1
            ORDER BY c.created_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&db_pool)
        .await
        .map_err(AppError::from)?;

        let (tx, rx) = tokio::sync::mpsc::channel(100);

        tokio::spawn(async move {
            for chat in chats {
                let participants: Vec<String> = sqlx::query_scalar(
                    "SELECT user_id::text FROM chat_participants WHERE chat_id = $1",
                )
                .bind(chat.id)
                .fetch_all(&db_pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|id: Uuid| id.to_string())
                .collect();

                let proto_chat = ProtoChat {
                    id: chat.id.to_string(),
                    is_group: chat.is_group,
                    name: chat.name.clone().unwrap_or_default(),
                    participants,
                    created_at: chat.created_at.to_rfc3339(),
                    created_by: chat.created_by.to_string(),
                    is_favorites: chat.is_favorites,
                };

                if tx.send(Ok(proto_chat)).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    async fn get_messages(
        &self,
        request: Request<GetMessagesRequest>,
    ) -> Result<Response<MessagesPage>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let page_size = req.limit.clamp(1, 100);
        let cursor = req.cursor.parse::<i32>().unwrap_or(0);

        let topic_filter = req
            .topic_id
            .as_ref()
            .filter(|s: &&String| !s.is_empty())
            .and_then(|s| Uuid::parse_str(s).ok());

        let messages = match topic_filter {
            Some(tid) => sqlx::query_as::<_, crate::models::Message>(
                r#"
                    SELECT * FROM messages
                    WHERE chat_id = $1 AND deleted_at IS NULL AND topic_id = $2
                    ORDER BY created_at DESC
                    LIMIT $3 OFFSET $4
                    "#,
            )
            .bind(chat_id)
            .bind(tid)
            .bind(page_size)
            .bind(cursor)
            .fetch_all(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?,
            None => sqlx::query_as::<_, crate::models::Message>(
                r#"
                    SELECT * FROM messages
                    WHERE chat_id = $1 AND deleted_at IS NULL
                    ORDER BY created_at DESC
                    LIMIT $2 OFFSET $3
                    "#,
            )
            .bind(chat_id)
            .bind(page_size)
            .bind(cursor)
            .fetch_all(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?,
        };

        let has_more = messages.len() as i32 == page_size;

        Ok(Response::new(MessagesPage {
            messages: messages.iter().map(|m| self.message_to_proto(m)).collect(),
            has_more,
            next_cursor: format!("{}", cursor + messages.len() as i32),
        }))
    }

    async fn send_message(
        &self,
        request: Request<SendMessageRequest>,
    ) -> Result<Response<ProtoMessage>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let id = Uuid::new_v4();
        let now = chrono::Utc::now();

        let file_metadata_id = (!req.file_metadata_id.is_empty())
            .then(|| Uuid::parse_str(&req.file_metadata_id).ok())
            .flatten();

        let topic_id = req
            .topic_id
            .as_ref()
            .filter(|s| !s.is_empty())
            .and_then(|s| Uuid::parse_str(s).ok());

        sqlx::query(
            r#"
            INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, file_metadata_id, topic_id, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'sent', $8)
            "#
        )
        .bind(id)
        .bind(chat_id)
        .bind(user_id)
        .bind(&req.content)
        .bind(&req.content_type)
        .bind(file_metadata_id)
        .bind(topic_id)
        .bind(now)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let message =
            sqlx::query_as::<_, crate::models::Message>("SELECT * FROM messages WHERE id = $1")
                .bind(id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        let proto_message = self.message_to_proto(&message);
        
        let pubsub_msg = ChatPubSubEvent::Message {
            id: proto_message.id.clone(),
            chat_id: proto_message.chat_id.clone(),
            sender_id: proto_message.sender_id.clone(),
            encrypted_content: proto_message.encrypted_content.clone(),
            content_type: proto_message.content_type.clone(),
            file_metadata_id: proto_message.file_metadata_id.clone(),
            status: proto_message.status.clone(),
            edited: proto_message.edited,
            deleted: proto_message.deleted,
            created_at: proto_message.created_at.clone(),
            edited_at: proto_message.edited_at.clone(),
            topic_id: proto_message.topic_id.clone(),
            thread_id: proto_message.thread_id.clone(),
        };
        
        if let Ok(json) = serde_json::to_string(&pubsub_msg) {
            let channel = format!("chat:{}", chat_id);
            let _ = self.state.redis.publish(&channel, &json).await;
        }

        // Increment unread counts for all other participants
        sqlx::query(
            r#"
            INSERT INTO unread_counts (user_id, chat_id, count, last_message_at)
            SELECT cp.user_id, $1, 1, $2
            FROM chat_participants cp
            WHERE cp.chat_id = $1
              AND cp.user_id != $3
            ON CONFLICT (user_id, chat_id)
            DO UPDATE SET count = unread_counts.count + 1, last_message_at = $2
            "#,
        )
        .bind(chat_id)
        .bind(now)
        .bind(user_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(proto_message))
    }

    type StreamMessagesStream =
        tokio_stream::wrappers::ReceiverStream<Result<StreamingMessage, Status>>;

    async fn stream_messages(
        &self,
        request: Request<StreamRequest>,
    ) -> Result<Response<Self::StreamMessagesStream>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let channel = format!("chat:{}", chat_id);
        let mut rx = self.state.redis.subscribe(&channel)
            .await
            .map_err(AppError::Redis)?;

        let (tx, stream_rx) = tokio::sync::mpsc::channel(100);

        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Ok(event) = serde_json::from_str::<ChatPubSubEvent>(&msg) {
                    let streaming_msg = match event {
                        ChatPubSubEvent::Message {
                            id,
                            chat_id,
                            sender_id,
                            encrypted_content,
                            content_type,
                            file_metadata_id,
                            status,
                            edited,
                            deleted,
                            created_at,
                            edited_at,
                            topic_id,
                            thread_id,
                        } => {
                            let proto_msg = ProtoMessage {
                                id,
                                chat_id,
                                sender_id,
                                encrypted_content,
                                content_type,
                                file_metadata_id,
                                status,
                                edited,
                                deleted,
                                created_at,
                                edited_at,
                                topic_id,
                                thread_id,
                            };
                            StreamingMessage {
                                event: Some(
                                    crate::proto::messaging::streaming_message::Event::Message(
                                        proto_msg,
                                    ),
                                ),
                            }
                        }
                        ChatPubSubEvent::Typing { user_id, .. } => StreamingMessage {
                            event: Some(
                                crate::proto::messaging::streaming_message::Event::Typing(user_id),
                            ),
                        },
                        ChatPubSubEvent::ReadReceipt {
                            reader_id,
                            message_id,
                            ..
                        } => StreamingMessage {
                            event: Some(
                                crate::proto::messaging::streaming_message::Event::Presence(
                                    format!("read:{}:{}", reader_id, message_id),
                                ),
                            ),
                        },
                    };
                    if tx.send(Ok(streaming_msg)).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(stream_rx)))
    }

    async fn edit_message(
        &self,
        request: Request<EditMessageRequest>,
    ) -> Result<Response<ProtoMessage>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let message_id: Uuid = req
            .message_id
            .parse()
            .map_err(|_| AppError::MessageNotFound)?;

        let (sender_id, chat_id): (Uuid, Uuid) = sqlx::query_as(
            "SELECT sender_id, chat_id FROM messages WHERE id = $1"
        )
        .bind(message_id)
        .fetch_optional(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::MessageNotFound)?;

        if sender_id != user_id {
            return Err(AppError::NotAuthorized.into());
        }

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query("UPDATE messages SET encrypted_content = $1, edited_at = NOW() WHERE id = $2")
            .bind(&req.content)
            .bind(message_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        let message =
            sqlx::query_as::<_, crate::models::Message>("SELECT * FROM messages WHERE id = $1")
                .bind(message_id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        Ok(Response::new(self.message_to_proto(&message)))
    }

    async fn delete_message(
        &self,
        request: Request<DeleteMessageRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let message_id: Uuid = req
            .message_id
            .parse()
            .map_err(|_| AppError::MessageNotFound)?;

        let (sender_id, chat_id): (Uuid, Uuid) = sqlx::query_as(
            "SELECT sender_id, chat_id FROM messages WHERE id = $1"
        )
        .bind(message_id)
        .fetch_optional(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::MessageNotFound)?;

        if sender_id != user_id {
            return Err(AppError::NotAuthorized.into());
        }

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query("UPDATE messages SET deleted_at = NOW() WHERE id = $1")
            .bind(message_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "Message deleted".to_string(),
        }))
    }

    async fn pin_message(
        &self,
        request: Request<PinMessageRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let message_id: Uuid = req
            .message_id
            .parse()
            .map_err(|_| AppError::MessageNotFound)?;

        let pinned_user_id = if req.personal { Some(user_id) } else { None };

        let chat_id: Uuid = sqlx::query_scalar("SELECT chat_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::MessageNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query(
            r#"
            INSERT INTO pinned_messages (message_id, user_id, chat_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (message_id, user_id) DO NOTHING
            "#,
        )
        .bind(message_id)
        .bind(pinned_user_id)
        .bind(chat_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "Message pinned".to_string(),
        }))
    }

    async fn unpin_message(
        &self,
        request: Request<UnpinMessageRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let message_id: Uuid = req
            .message_id
            .parse()
            .map_err(|_| AppError::MessageNotFound)?;

        let pinned_user_id = if req.personal { Some(user_id) } else { None };

        let chat_id: Uuid = sqlx::query_scalar("SELECT chat_id FROM messages WHERE id = $1")
            .bind(message_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::MessageNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query(
            "DELETE FROM pinned_messages WHERE message_id = $1 AND user_id IS NOT DISTINCT FROM $2",
        )
        .bind(message_id)
        .bind(pinned_user_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "Message unpinned".to_string(),
        }))
    }

    async fn get_pinned_messages(
        &self,
        request: Request<GetPinnedMessagesRequest>,
    ) -> Result<Response<GetPinnedMessagesResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let pinned = sqlx::query_as::<_, crate::models::PinnedMessage>(
            r#"
            SELECT pm.* FROM pinned_messages pm
            WHERE pm.chat_id = $1
              AND (pm.user_id IS NULL OR pm.user_id = $2)
            ORDER BY pm.created_at DESC
            "#,
        )
        .bind(chat_id)
        .bind(user_id)
        .fetch_all(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let mut result = Vec::new();
        for p in pinned {
            let msg =
                sqlx::query_as::<_, crate::models::Message>("SELECT * FROM messages WHERE id = $1")
                    .bind(p.message_id)
                    .fetch_optional(self.state.db.get_pool())
                    .await
                    .map_err(AppError::from)?;

            if let Some(m) = msg {
                result.push(ProtoPinnedMessage {
                    message: Some(self.message_to_proto(&m)),
                    personal: p.user_id.is_some(),
                });
            }
        }

        Ok(Response::new(GetPinnedMessagesResponse {
            pinned_messages: result,
        }))
    }

    async fn create_thread(
        &self,
        request: Request<CreateThreadRequest>,
    ) -> Result<Response<Thread>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let root_message_id: Uuid = req
            .message_id
            .parse()
            .map_err(|_| AppError::MessageNotFound)?;

        let chat_id: Uuid = sqlx::query_scalar("SELECT chat_id FROM messages WHERE id = $1")
            .bind(root_message_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::MessageNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let thread_id = Uuid::new_v4();
        let now = chrono::Utc::now();

        sqlx::query(
            r#"
            INSERT INTO threads (id, chat_id, root_message_id, created_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(thread_id)
        .bind(chat_id)
        .bind(root_message_id)
        .bind(now)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        sqlx::query(
            r#"
            INSERT INTO messages (id, chat_id, sender_id, encrypted_content, content_type, thread_id, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7)
            "#
        )
        .bind(Uuid::new_v4())
        .bind(chat_id)
        .bind(user_id)
        .bind(&req.content)
        .bind(&req.content_type)
        .bind(thread_id)
        .bind(now)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let thread =
            sqlx::query_as::<_, crate::models::Thread>("SELECT * FROM threads WHERE id = $1")
                .bind(thread_id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        let reply_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE thread_id = $1")
                .bind(thread_id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        Ok(Response::new(self.thread_to_proto(&thread, reply_count)))
    }

    async fn get_thread(
        &self,
        request: Request<GetThreadRequest>,
    ) -> Result<Response<Thread>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let thread_id: Uuid = req
            .thread_id
            .parse()
            .map_err(|_| Status::invalid_argument("Invalid thread_id"))?;

        let thread =
            sqlx::query_as::<_, crate::models::Thread>("SELECT * FROM threads WHERE id = $1")
                .bind(thread_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?
                .ok_or(AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), thread.chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let reply_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE thread_id = $1")
                .bind(thread_id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        Ok(Response::new(self.thread_to_proto(&thread, reply_count)))
    }

    async fn get_thread_messages(
        &self,
        request: Request<GetThreadMessagesRequest>,
    ) -> Result<Response<MessagesPage>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let thread_id: Uuid = req
            .thread_id
            .parse()
            .map_err(|_| Status::invalid_argument("Invalid thread_id"))?;
        
        let thread =
            sqlx::query_as::<_, crate::models::Thread>("SELECT * FROM threads WHERE id = $1")
                .bind(thread_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?
                .ok_or(AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), thread.chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let cursor = req.cursor.parse::<i32>().unwrap_or(0);
        let limit = 50i32;

        let messages = sqlx::query_as::<_, crate::models::Message>(
            r#"
            SELECT * FROM messages
            WHERE thread_id = $1 AND deleted_at IS NULL
            ORDER BY created_at ASC
            LIMIT $2 OFFSET $3
            "#,
        )
        .bind(thread_id)
        .bind(limit)
        .bind(cursor)
        .fetch_all(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let has_more = messages.len() as i32 == limit;

        Ok(Response::new(MessagesPage {
            messages: messages.iter().map(|m| self.message_to_proto(m)).collect(),
            has_more,
            next_cursor: format!("{}", cursor + messages.len() as i32),
        }))
    }

    async fn create_topic(
        &self,
        request: Request<CreateTopicRequest>,
    ) -> Result<Response<Topic>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let now = chrono::Utc::now();
        let topic_id = Uuid::new_v4();

        sqlx::query(
            r#"
            INSERT INTO topics (id, chat_id, name, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(topic_id)
        .bind(chat_id)
        .bind(&req.name)
        .bind(user_id)
        .bind(now)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let topic = sqlx::query_as::<_, crate::models::Topic>("SELECT * FROM topics WHERE id = $1")
            .bind(topic_id)
            .fetch_one(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(self.topic_to_proto(&topic)))
    }

    async fn get_topics(
        &self,
        request: Request<GetTopicsRequest>,
    ) -> Result<Response<TopicsResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        let topics = sqlx::query_as::<_, crate::models::Topic>(
            "SELECT * FROM topics WHERE chat_id = $1 ORDER BY created_at ASC",
        )
        .bind(chat_id)
        .fetch_all(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(TopicsResponse {
            topics: topics.iter().map(|t| self.topic_to_proto(t)).collect(),
        }))
    }

    async fn get_unread_counts(
        &self,
        request: Request<crate::proto::common::Empty>,
    ) -> Result<Response<crate::proto::messaging::UnreadCountsResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let counts = sqlx::query_as::<_, crate::models::UnreadCount>(
            "SELECT * FROM unread_counts WHERE user_id = $1 AND count > 0 ORDER BY last_message_at DESC",
        )
        .bind(user_id)
        .fetch_all(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let proto_counts: Vec<crate::proto::messaging::ChatUnreadCount> = counts
            .into_iter()
            .map(|c| crate::proto::messaging::ChatUnreadCount {
                chat_id: c.chat_id.to_string(),
                count: c.count,
                last_message_at: c
                    .last_message_at
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default(),
            })
            .collect();

        Ok(Response::new(
            crate::proto::messaging::UnreadCountsResponse {
                counts: proto_counts,
            },
        ))
    }

    async fn mark_chat_read(
        &self,
        request: Request<MarkChatReadRequest>,
    ) -> Result<Response<crate::proto::common::Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query(
            "UPDATE unread_counts SET count = 0 WHERE user_id = $1 AND chat_id = $2",
        )
        .bind(user_id)
        .bind(chat_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(crate::proto::common::Ack {
            success: true,
            message: "Chat marked as read".to_string(),
        }))
    }

    async fn mark_all_read(
        &self,
        request: Request<crate::proto::common::Empty>,
    ) -> Result<Response<crate::proto::common::Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        sqlx::query("UPDATE unread_counts SET count = 0 WHERE user_id = $1")
            .bind(user_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(crate::proto::common::Ack {
            success: true,
            message: "All chats marked as read".to_string(),
        }))
    }

    async fn mark_message_read(
        &self,
        request: Request<MarkMessageReadRequest>,
    ) -> Result<Response<crate::proto::common::Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let message_id: Uuid = req.message_id.parse().map_err(|_| AppError::MessageNotFound)?;

        // Get the message's chat_id and created_at
        let (chat_id, created_at): (Uuid, chrono::DateTime<chrono::Utc>) =
            sqlx::query_as("SELECT chat_id, created_at FROM messages WHERE id = $1")
                .bind(message_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?
                .ok_or(AppError::MessageNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        // Mark all messages from this sender before this message as 'read'
        sqlx::query(
            "UPDATE messages SET status = 'read' WHERE chat_id = $1 AND sender_id != $2 AND created_at <= $3 AND status != 'read'",
        )
        .bind(chat_id)
        .bind(user_id)
        .bind(created_at)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        // Reset unread count for this user/chat
        sqlx::query(
            "UPDATE unread_counts SET count = 0 WHERE user_id = $1 AND chat_id = $2",
        )
        .bind(user_id)
        .bind(chat_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        // Publish read receipt via Redis pub/sub
        let read_event = ChatPubSubEvent::ReadReceipt {
            chat_id: chat_id.to_string(),
            reader_id: user_id.to_string(),
            message_id: message_id.to_string(),
        };

        let channel = format!("chat:{}", chat_id);
        if let Ok(json) = serde_json::to_string(&read_event) {
            let _ = self.state.redis.publish(&channel, &json).await;
        }

        Ok(Response::new(crate::proto::common::Ack {
            success: true,
            message: "Messages marked as read".to_string(),
        }))
    }

    async fn send_typing(
        &self,
        request: Request<SendTypingRequest>,
    ) -> Result<Response<crate::proto::common::Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

        if !check_chat_participation(self.state.db.get_pool(), chat_id, user_id).await? {
            return Err(AppError::NotAuthorized.into());
        }

        // Publish typing event via Redis pub/sub
        let typing_event = ChatPubSubEvent::Typing {
            chat_id: chat_id.to_string(),
            user_id: user_id.to_string(),
        };

        let channel = format!("chat:{}", chat_id);
        if let Ok(json) = serde_json::to_string(&typing_event) {
            let _ = self.state.redis.publish(&channel, &json).await;
        }

        Ok(Response::new(crate::proto::common::Ack {
            success: true,
            message: "Typing indicator sent".to_string(),
        }))
    }
}
