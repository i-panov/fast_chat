use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Redis error: {0}")]
    Redis(String),

    #[error("Invalid credentials")]
    InvalidCredentials,

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

    #[error("Registration is disabled")]
    RegistrationDisabled,

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

    #[error("Internal server error")]
    Internal,

    #[error("Validation error: {0}")]
    Validation(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            AppError::InvalidCredentials => (StatusCode::UNAUTHORIZED, "Invalid credentials"),
            AppError::TokenExpired => (StatusCode::UNAUTHORIZED, "Token expired"),
            AppError::InvalidToken => (StatusCode::UNAUTHORIZED, "Invalid token"),
            AppError::UserNotFound => (StatusCode::NOT_FOUND, "User not found"),
            AppError::ChatNotFound => (StatusCode::NOT_FOUND, "Chat not found"),
            AppError::MessageNotFound => (StatusCode::NOT_FOUND, "Message not found"),
            AppError::FileNotFound => (StatusCode::NOT_FOUND, "File not found"),
            AppError::NotAuthorized => (StatusCode::FORBIDDEN, "Not authorized"),
            AppError::RegistrationDisabled => (StatusCode::FORBIDDEN, "Registration is disabled. Please contact your administrator."),
            AppError::TwoFactorNotConfigured => {
                (StatusCode::PRECONDITION_FAILED, "2FA not configured")
            }
            AppError::InvalidTwoFactorCode => (StatusCode::BAD_REQUEST, "Invalid 2FA code"),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.as_str()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
        };

        let body = json!({
            "error": message,
            "details": self.to_string(),
        });

        (status, Json(body)).into_response()
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        AppError::Redis(err.to_string())
    }
}

impl From<axum::extract::multipart::MultipartError> for AppError {
    fn from(err: axum::extract::multipart::MultipartError) -> Self {
        AppError::Validation(err.to_string())
    }
}
