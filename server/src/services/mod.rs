//! Service layer — business logic separation.
//! 
//! Services contain business rules and orchestrate repository operations.
//! They are independent of HTTP frameworks.

pub mod auth_service;
pub mod chat_service;

pub use auth_service::AuthService;
pub use chat_service::ChatService;
