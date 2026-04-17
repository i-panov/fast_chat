//! Repository layer — data access abstraction.
//! 
//! Repositories provide a clean interface for data access operations,
//! separating business logic from database queries.

pub mod user_repo;
pub mod chat_repo;
pub mod message_repo;
pub mod session_repo;
pub mod settings_repo;

pub use user_repo::UserRepository;
pub use chat_repo::ChatRepository;
pub use message_repo::MessageRepository;
pub use session_repo::SessionRepository;
pub use settings_repo::SettingsRepository;
