use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[allow(dead_code)]
pub struct ActiveCall {
    pub id: Uuid,
    pub chat_id: Option<Uuid>,
    pub caller_id: Uuid,
    pub callee_id: Option<Uuid>,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum CallStatus {
    Pending,
    Ringing,
    Active,
    Ended,
    Declined,
}

impl From<&str> for CallStatus {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "pending" => CallStatus::Pending,
            "ringing" => CallStatus::Ringing,
            "active" => CallStatus::Active,
            "ended" => CallStatus::Ended,
            "declined" => CallStatus::Declined,
            _ => CallStatus::Pending,
        }
    }
}
