use thiserror::Error;
use tonic::Status;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Redis error: {0}")]
    Redis(#[from] redis::RedisError),

    #[error("Invalid credentials")]
    InvalidCredentials,

    #[error("User already exists")]
    UserExists,

    #[error("Token expired")]
    TokenExpired,

    #[error("Invalid token")]
    InvalidToken,

    #[error("User not found")]
    UserNotFound,

    #[error("Chat not found")]
    ChatNotFound,

    #[error("Message not found")]
    MessageNotFound,

    #[error("File not found")]
    FileNotFound,

    #[error("Not authorized")]
    NotAuthorized,

    #[error("2FA not configured")]
    TwoFactorNotConfigured,

    #[error("Invalid 2FA code")]
    InvalidTwoFactorCode,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("JWT error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("Argon2 error")]
    Argon2,

    #[error("Internal server error")]
    Internal,
}

impl From<AppError> for Status {
    fn from(err: AppError) -> Self {
        use tonic::Code;

        let code = match &err {
            AppError::InvalidCredentials => Code::Unauthenticated,
            AppError::TokenExpired => Code::Unauthenticated,
            AppError::InvalidToken => Code::Unauthenticated,
            AppError::UserNotFound => Code::NotFound,
            AppError::ChatNotFound => Code::NotFound,
            AppError::MessageNotFound => Code::NotFound,
            AppError::FileNotFound => Code::NotFound,
            AppError::NotAuthorized => Code::PermissionDenied,
            AppError::UserExists => Code::AlreadyExists,
            AppError::TwoFactorNotConfigured => Code::FailedPrecondition,
            AppError::InvalidTwoFactorCode => Code::InvalidArgument,
            AppError::Database(_) => Code::Internal,
            AppError::Redis(_) => Code::Internal,
            AppError::Io(_) => Code::Internal,
            AppError::Serialization(_) => Code::Internal,
            AppError::Jwt(_) => Code::Internal,
            AppError::Argon2 => Code::Internal,
            AppError::Internal => Code::Internal,
        };

        Status::new(code, err.to_string())
    }
}
