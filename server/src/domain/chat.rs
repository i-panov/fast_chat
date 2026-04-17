//! Domain chat entity.

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Chat as a domain concept
#[derive(Debug, Clone)]
pub struct Chat {
    pub id: Uuid,
    pub is_group: bool,
    pub name: Option<String>,
    pub created_by: Uuid,
    pub is_favorites: bool,
    pub created_at: DateTime<Utc>,
}

impl Chat {
    pub fn is_direct(&self) -> bool {
        !self.is_group
    }

    pub fn is_group_chat(&self) -> bool {
        self.is_group
    }
}
