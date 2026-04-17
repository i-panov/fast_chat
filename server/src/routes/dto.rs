//! Re-exports from dto module for backward compatibility.
//! 
//! All DTOs are now defined in the `dto/` module.
//! This file re-exports them for routes that import from `routes::dto`.

// Auth DTOs
pub use crate::dto::auth::{
    CreateUserRequest, Disable2faRequest, Need2faResponse, RefreshRequest,
    RequestCodeRequest, TotpEnableResponse, TotpSetupRequest, TotpSetupResponse,
    TokenResponse, UpdatePublicKeyRequest, UpdateUserRequest, UserResponse,
    Verify2faRequest, VerifyCodeRequest,
};

// Chat DTOs
pub use crate::dto::chat::{ChatResponse, ChatsListResponse, CreateChatRequest};

// Message DTOs
pub use crate::dto::message::{
    CreateThreadRequest, CreateTopicRequest, EditMessageRequest,
    GetMessagesQuery, GetTopicsQuery, MessageResponse as MessageResponse, MessagesPage,
    SendMessageRequest, ThreadResponse, TopicResponse,
};

// Common DTOs
pub use crate::dto::common::{
    Ack, CallResponse, CreateCallRequest, FileResponse, IdResponse, 
    ParticipantsResponse, PaginationQuery,
};
