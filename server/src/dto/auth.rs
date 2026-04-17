//! Auth-related DTOs

use serde::{Deserialize, Serialize};

// ============ Requests ============

#[derive(Debug, Deserialize)]
pub struct RequestCodeRequest {
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyCodeRequest {
    pub email: String,
    pub code: String,
    #[serde(default)]
    pub totp_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Verify2faRequest {
    pub totp_code: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct Disable2faRequest {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct TotpSetupRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePublicKeyRequest {
    pub public_key: String,
}

// ============ User DTOs (used by users routes) ============

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub email: Option<String>,
    pub is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub username: Option<String>,
    pub email: Option<String>,
}

// ============ Responses ============

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: UserResponse,
}

#[derive(Debug, Serialize, Clone)]
pub struct UserResponse {
    pub id: String,
    pub username: String,
    pub email: String,
    pub is_admin: bool,
    pub totp_enabled: bool,
    pub created_at: String,
}

impl From<&crate::models::User> for UserResponse {
    fn from(user: &crate::models::User) -> Self {
        Self {
            id: user.id.to_string(),
            username: user.username.clone(),
            email: user.email.clone(),
            is_admin: user.is_admin,
            totp_enabled: user.totp_enabled,
            created_at: user.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Need2faResponse {
    pub need_2fa: bool,
    pub require_2fa: bool,
    pub user_id: String,
    pub challenge_token: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TotpSetupResponse {
    pub secret: String,
    pub qr_code_url: String,
}

#[derive(Debug, Serialize)]
pub struct TotpEnableResponse {
    pub success: bool,
    pub message: String,
    pub backup_codes: Vec<String>,
    pub access_token: String,
    pub refresh_token: String,
    pub user: UserResponse,
}

#[derive(Debug, Serialize)]
pub struct BackupCodesResponse {
    pub codes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub success: bool,
    pub message: String,
}
