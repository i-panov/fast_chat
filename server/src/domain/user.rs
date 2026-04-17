//! Domain user entity.

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// User as a domain concept (read-only representation)
#[derive(Debug, Clone)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub totp_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl User {
    pub fn is_active(&self) -> bool {
        !self.disabled
    }

    pub fn can_access_admin_panel(&self) -> bool {
        self.is_admin && !self.disabled
    }
}
