use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::middleware::get_user_id_from_request;
use crate::proto::common::Ack;
use crate::proto::signaling::{
    AcceptCallRequest, CallEndRequest, CallEvent, CallRequest, DeclineCallRequest,
    GetSfuConfigRequest, GroupCallEvent, IceCandidate, JoinGroupCallRequest, LeaveGroupCallRequest,
    SfuConfig,
};
use crate::{error::AppError, AppState};

/// Events published via Redis pub/sub for 1:1 calls
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum CallPubSubEvent {
    Ringing { call_id: String },
    Accepted { call_id: String, sdp_offer: String },
    Answer { call_id: String, sdp_answer: String },
    IceCandidate { call_id: String, candidate: String },
    Ended { call_id: String },
    Declined { call_id: String },
}

/// Events published via Redis pub/sub for group calls
#[allow(clippy::enum_variant_names)]
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum GroupCallPubSubEvent {
    ParticipantJoined {
        call_id: String,
        user_id: String,
        sdp_offer: String,
    },
    ParticipantAnswered {
        call_id: String,
        user_id: String,
        sdp_answer: String,
    },
    ParticipantIce {
        call_id: String,
        user_id: String,
        candidate: String,
    },
    ParticipantLeft {
        call_id: String,
        user_id: String,
    },
}

pub struct SignalingService {
    state: Arc<AppState>,
}

impl SignalingService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn get_sfu_config(&self) -> Option<SfuConfig> {
        self.state
            .settings
            .ion_sfu_url
            .as_ref()
            .map(|url| SfuConfig {
                url: url.clone(),
                ice_servers: vec![
                    format!(
                        "stun:{}:{}",
                        self.state.settings.coturn_host, self.state.settings.coturn_port
                    ),
                    format!(
                        "turn:{}:{}?transport=udp",
                        self.state.settings.coturn_host, self.state.settings.coturn_port
                    ),
                    format!(
                        "turn:{}:{}?transport=tcp",
                        self.state.settings.coturn_host, self.state.settings.coturn_port
                    ),
                ],
            })
    }

    fn call_channel(call_id: Uuid) -> String {
        format!("call:{}", call_id)
    }

    fn group_call_channel(call_id: Uuid) -> String {
        format!("group_call:{}", call_id)
    }

    async fn publish_call_event(&self, call_id: Uuid, event: &CallPubSubEvent) {
        let channel = Self::call_channel(call_id);
        if let Ok(json) = serde_json::to_string(event) {
            let _ = self.state.redis.publish(&channel, &json).await;
        }
    }

    async fn publish_group_call_event(&self, call_id: Uuid, event: &GroupCallPubSubEvent) {
        let channel = Self::group_call_channel(call_id);
        if let Ok(json) = serde_json::to_string(event) {
            let _ = self.state.redis.publish(&channel, &json).await;
        }
    }
}

#[tonic::async_trait]
impl crate::proto::signaling::signaling_server::Signaling for SignalingService {
    type CallUserStream =
        tokio_stream::wrappers::ReceiverStream<Result<CallEvent, Status>>;

    async fn call_user(
        &self,
        request: Request<CallRequest>,
    ) -> Result<Response<Self::CallUserStream>, Status> {
        let caller_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let call_id = Uuid::new_v4();
        let callee_id: Uuid = req.callee_id.parse().map_err(|_| AppError::UserNotFound)?;

        sqlx::query(
            r#"
            INSERT INTO active_calls (id, caller_id, callee_id, status)
            VALUES ($1, $2, $3, 'pending')
            "#,
        )
        .bind(call_id)
        .bind(caller_id)
        .bind(callee_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        // Publish ringing event so callee's client can be notified
        self.publish_call_event(
            call_id,
            &CallPubSubEvent::Ringing {
                call_id: call_id.to_string(),
            },
        )
        .await;

        // Subscribe to call events channel — caller receives accept/decline/ice/ended
        let channel = Self::call_channel(call_id);
        let mut rx = self
            .state
            .redis
            .subscribe(&channel)
            .await
            .map_err(|e| Status::internal(format!("Failed to subscribe: {}", e)))?;

        let (tx, stream_rx) = tokio::sync::mpsc::channel(100);

        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Ok(event) = serde_json::from_str::<CallPubSubEvent>(&msg) {
                    use crate::proto::signaling::call_event;
                    let call_event = match event {
                        CallPubSubEvent::Ringing { call_id } => CallEvent {
                            event: Some(call_event::Event::Ringing(call_event::Ringing {
                                call_id,
                            })),
                        },
                        CallPubSubEvent::Accepted {
                            call_id,
                            sdp_offer,
                        } => CallEvent {
                            event: Some(call_event::Event::Accepted(call_event::Accepted {
                                call_id,
                                sdp_offer,
                            })),
                        },
                        CallPubSubEvent::Answer {
                            call_id,
                            sdp_answer,
                        } => CallEvent {
                            event: Some(call_event::Event::Answer(call_event::Answer {
                                call_id,
                                sdp_answer,
                            })),
                        },
                        CallPubSubEvent::IceCandidate {
                            call_id,
                            candidate,
                        } => CallEvent {
                            event: Some(call_event::Event::IceCandidate(
                                call_event::IceCandidate {
                                    call_id,
                                    candidate,
                                },
                            )),
                        },
                        CallPubSubEvent::Ended { call_id } => CallEvent {
                            event: Some(call_event::Event::Ended(call_event::Ended { call_id })),
                        },
                        CallPubSubEvent::Declined { call_id } => CallEvent {
                            event: Some(call_event::Event::Declined(call_event::Declined {
                                call_id,
                            })),
                        },
                    };
                    if tx.send(Ok(call_event)).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            stream_rx,
        )))
    }

    async fn accept_call(
        &self,
        request: Request<AcceptCallRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let call_id: Uuid = req.call_id.parse().map_err(|_| AppError::ChatNotFound)?;

        let callee_id: Option<Uuid> =
            sqlx::query_scalar("SELECT callee_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        if callee_id != Some(user_id) {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query("UPDATE active_calls SET status = 'active' WHERE id = $1")
            .bind(call_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        // Publish accepted event with caller's SDP offer so callee can generate answer
        self.publish_call_event(
            call_id,
            &CallPubSubEvent::Accepted {
                call_id: call_id.to_string(),
                sdp_offer: req.sdp_answer.clone(),
            },
        )
        .await;

        Ok(Response::new(Ack {
            success: true,
            message: "Call accepted".to_string(),
        }))
    }

    async fn decline_call(
        &self,
        request: Request<DeclineCallRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let call_id: Uuid = req.call_id.parse().map_err(|_| AppError::ChatNotFound)?;

        let callee_id: Option<Uuid> =
            sqlx::query_scalar("SELECT callee_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        if callee_id != Some(user_id) {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query("UPDATE active_calls SET status = 'declined', ended_at = NOW() WHERE id = $1")
            .bind(call_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        // Publish declined event so caller knows call was rejected
        self.publish_call_event(
            call_id,
            &CallPubSubEvent::Declined {
                call_id: call_id.to_string(),
            },
        )
        .await;

        Ok(Response::new(Ack {
            success: true,
            message: "Call declined".to_string(),
        }))
    }

    async fn end_call(&self, request: Request<CallEndRequest>) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let call_id: Uuid = req.call_id.parse().map_err(|_| AppError::ChatNotFound)?;

        let caller_id: Option<Uuid> =
            sqlx::query_scalar("SELECT caller_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        let callee_id: Option<Uuid> =
            sqlx::query_scalar("SELECT callee_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        if caller_id != Some(user_id) && callee_id != Some(user_id) {
            return Err(AppError::NotAuthorized.into());
        }

        sqlx::query("UPDATE active_calls SET status = 'ended', ended_at = NOW() WHERE id = $1")
            .bind(call_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        // Publish ended event so both parties know call is over
        self.publish_call_event(
            call_id,
            &CallPubSubEvent::Ended {
                call_id: call_id.to_string(),
            },
        )
        .await;

        Ok(Response::new(Ack {
            success: true,
            message: "Call ended".to_string(),
        }))
    }

    async fn ice_candidate(&self, request: Request<IceCandidate>) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let call_id: Uuid = req.call_id.parse().map_err(|_| AppError::ChatNotFound)?;

        // Verify the user is a participant in this call
        let caller_id: Option<Uuid> =
            sqlx::query_scalar("SELECT caller_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        let callee_id: Option<Uuid> =
            sqlx::query_scalar("SELECT callee_id FROM active_calls WHERE id = $1")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        if caller_id != Some(user_id) && callee_id != Some(user_id) {
            return Err(AppError::NotAuthorized.into());
        }

        tracing::debug!("ICE candidate received for call: {} from user: {}", call_id, user_id);

        // Relay ICE candidate via Redis pub/sub so the peer receives it
        self.publish_call_event(
            call_id,
            &CallPubSubEvent::IceCandidate {
                call_id: call_id.to_string(),
                candidate: req.candidate.clone(),
            },
        )
        .await;

        Ok(Response::new(Ack {
            success: true,
            message: "ICE candidate relayed".to_string(),
        }))
    }

    type JoinGroupCallStream =
        tokio_stream::wrappers::ReceiverStream<Result<GroupCallEvent, Status>>;

    /// Join a group call.
    /// NOTE: Current architecture creates a separate active_calls record per participant,
    /// but events are published on the participant's own channel. This means participants
    /// DON'T hear each other — a known limitation. A proper fix would use a single chat-level
    /// call record with a shared Redis channel, or integrate with Ion SFU for media routing.
    async fn join_group_call(
        &self,
        request: Request<JoinGroupCallRequest>,
    ) -> Result<Response<Self::JoinGroupCallStream>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let chat_id: Uuid = req.chat_id.parse().map_err(|_| AppError::ChatNotFound)?;
        let call_id = Uuid::new_v4();

        let participant_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_participants WHERE chat_id = $1")
                .bind(chat_id)
                .fetch_one(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        let is_sfu_needed = participant_count > 2;

        if is_sfu_needed {
            if let Some(sfu_config) = self.get_sfu_config() {
                tracing::info!(
                    "Group call with {} participants - using SFU at {}",
                    participant_count,
                    sfu_config.url
                );
            }
        }

        sqlx::query(
            r#"
            INSERT INTO active_calls (id, chat_id, caller_id, status)
            VALUES ($1, $2, $3, 'active')
            "#,
        )
        .bind(call_id)
        .bind(chat_id)
        .bind(user_id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        // Publish participant joined event
        self.publish_group_call_event(
            call_id,
            &GroupCallPubSubEvent::ParticipantJoined {
                call_id: call_id.to_string(),
                user_id: user_id.to_string(),
                sdp_offer: req.sdp_offer.clone(),
            },
        )
        .await;

        // Subscribe to group call events
        let channel = Self::group_call_channel(call_id);
        let mut rx = self
            .state
            .redis
            .subscribe(&channel)
            .await
            .map_err(|e| Status::internal(format!("Failed to subscribe: {}", e)))?;

        let current_user_id = user_id.to_string();
        let (tx, stream_rx) = tokio::sync::mpsc::channel(100);

        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Ok(event) = serde_json::from_str::<GroupCallPubSubEvent>(&msg) {
                    // Don't echo own events back
                    match &event {
                        GroupCallPubSubEvent::ParticipantJoined { user_id, .. }
                        | GroupCallPubSubEvent::ParticipantAnswered { user_id, .. }
                        | GroupCallPubSubEvent::ParticipantIce { user_id, .. }
                        | GroupCallPubSubEvent::ParticipantLeft { user_id, .. }
                            if user_id == &current_user_id =>
                        {
                            continue;
                        }
                        _ => {}
                    }

                    use crate::proto::signaling::group_call_event as gce;
                    let group_event = match event {
                        GroupCallPubSubEvent::ParticipantJoined {
                            call_id,
                            user_id,
                            sdp_offer,
                        } => GroupCallEvent {
                            event: Some(gce::Event::ParticipantJoined(gce::ParticipantJoined {
                                call_id,
                                user_id,
                                sdp_offer,
                            })),
                        },
                        GroupCallPubSubEvent::ParticipantAnswered {
                            call_id,
                            user_id,
                            sdp_answer,
                        } => GroupCallEvent {
                            event: Some(gce::Event::ParticipantAnswered(gce::ParticipantAnswered {
                                call_id,
                                user_id,
                                sdp_answer,
                            })),
                        },
                        GroupCallPubSubEvent::ParticipantIce {
                            call_id,
                            user_id,
                            candidate,
                        } => GroupCallEvent {
                            event: Some(gce::Event::ParticipantIce(gce::ParticipantIce {
                                call_id,
                                user_id,
                                candidate,
                            })),
                        },
                        GroupCallPubSubEvent::ParticipantLeft { call_id, user_id } => {
                            GroupCallEvent {
                                event: Some(gce::Event::ParticipantLeft(gce::ParticipantLeft {
                                    call_id,
                                    user_id,
                                })),
                            }
                        }
                    };
                    if tx.send(Ok(group_event)).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            stream_rx,
        )))
    }

    async fn leave_group_call(
        &self,
        request: Request<LeaveGroupCallRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        let req = request.into_inner();
        let call_id: Uuid = req.call_id.parse().map_err(|_| AppError::ChatNotFound)?;

        // Check that the user is the caller of this specific call record
        let caller_id: Option<Uuid> =
            sqlx::query_scalar("SELECT caller_id FROM active_calls WHERE id = $1 AND status = 'active'")
                .bind(call_id)
                .fetch_optional(self.state.db.get_pool())
                .await
                .map_err(AppError::from)?;

        if caller_id != Some(user_id) {
            return Err(AppError::NotAuthorized.into());
        }

        // End this user's call record
        sqlx::query("UPDATE active_calls SET status = 'ended', ended_at = NOW() WHERE id = $1")
            .bind(call_id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        // Publish participant left event
        self.publish_group_call_event(
            call_id,
            &GroupCallPubSubEvent::ParticipantLeft {
                call_id: call_id.to_string(),
                user_id: user_id.to_string(),
            },
        )
        .await;

        // Check if there are any remaining active participants for this chat
        // If the call record was for a chat-level call (chat_id set, no other active records),
        // we could end the chat-level call too. For now, each participant manages their own record.

        Ok(Response::new(Ack {
            success: true,
            message: "Left group call".to_string(),
        }))
    }

    async fn get_sfu_config(
        &self,
        request: Request<GetSfuConfigRequest>,
    ) -> Result<Response<SfuConfig>, Status> {
        let _req = request.into_inner();
        let sfu_config = self
            .get_sfu_config()
            .ok_or_else(|| Status::not_found("SFU not configured"))?;

        Ok(Response::new(sfu_config))
    }
}
