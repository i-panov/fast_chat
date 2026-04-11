use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::sync::Arc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::middleware::get_user_id_from_request;
use crate::proto::common::{Ack, Empty, User as ProtoUser};
use crate::proto::users::{
    BackupCodesResponse, Disable2FaRequest, Enable2FaRequest, GetUserRequest,
    Setup2FaResponse, UpdatePasswordRequest, Verify2FaRequest,
};
use crate::{crypto::CryptoService, error::AppError, AppState};

pub struct UsersService {
    state: Arc<AppState>,
}

impl UsersService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    async fn get_user_by_id(&self, id: Uuid) -> Result<crate::models::User, AppError> {
        sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::UserNotFound)
    }

    fn user_to_proto(&self, user: &crate::models::User) -> ProtoUser {
        ProtoUser {
            id: user.id.to_string(),
            username: user.username.clone(),
            email: String::new(), // deprecated
            is_admin: user.is_admin,
            totp_enabled: user.totp_enabled,
            require_2fa: user.require_2fa,
            created_at: user.created_at.to_rfc3339(),
        }
    }

    fn generate_totp_secret(&self) -> String {
        use rand::RngCore;
        let mut secret = [0u8; 20];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        BASE64.encode(secret)
    }

    fn verify_totp(&self, secret: &str, code: &str) -> bool {
        use std::time::{SystemTime, UNIX_EPOCH};
        use totp_lite::{totp, Sha1};

        let secret_bytes = match BASE64.decode(secret) {
            Ok(b) => b,
            Err(_) => return false,
        };

        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time before UNIX epoch")
            .as_secs();
        let expected = totp::<Sha1>(&secret_bytes, seconds);
        expected == code
    }
}

#[tonic::async_trait]
impl crate::proto::users::users_server::Users for UsersService {
    async fn get_user(
        &self,
        request: Request<GetUserRequest>,
    ) -> Result<Response<ProtoUser>, Status> {
        let req = request.into_inner();
        let id: Uuid = req.id.parse().map_err(|_| AppError::UserNotFound)?;
        let user = self.get_user_by_id(id).await?;
        Ok(Response::new(self.user_to_proto(&user)))
    }

    async fn update_password(
        &self,
        request: Request<UpdatePasswordRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let user = self.get_user_by_id(user_id).await?;

        let valid = CryptoService::verify_password(&req.old_password, &user.password_hash)
            .map_err(|_| AppError::InvalidCredentials)?;

        if !valid {
            return Err(AppError::InvalidCredentials.into());
        }

        let new_hash = CryptoService::hash_password(&req.new_password)
            .map_err(|_| AppError::InvalidCredentials)?;

        sqlx::query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2")
            .bind(&new_hash)
            .bind(user.id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "Password updated".to_string(),
        }))
    }

    async fn setup2_fa(
        &self,
        request: Request<Empty>,
    ) -> Result<Response<Setup2FaResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let secret = self.generate_totp_secret();
        let user = self.get_user_by_id(user_id).await?;

        // Encrypt the TOTP secret before storing
        let encrypted_secret = CryptoService::encrypt_totp_secret(&secret, &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to encrypt TOTP secret"))?;

        sqlx::query("UPDATE users SET totp_secret = $1 WHERE id = $2")
            .bind(&encrypted_secret)
            .bind(user.id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        let qr_code_url = format!(
            "otpauth://totp/FastChat:{}?secret={}",
            user.username, secret
        );

        Ok(Response::new(Setup2FaResponse {
            secret,
            qr_code_url,
        }))
    }

    async fn verify2_fa_setup(
        &self,
        request: Request<Verify2FaRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let user = self.get_user_by_id(user_id).await?;

        let encrypted_secret = user
            .totp_secret
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("2FA not set up"))?;

        // Decrypt the TOTP secret
        let secret = CryptoService::decrypt_totp_secret(encrypted_secret, &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to decrypt TOTP secret"))?;

        if !self.verify_totp(&secret, &req.code) {
            return Err(AppError::InvalidTwoFactorCode.into());
        }

        Ok(Response::new(Ack {
            success: true,
            message: "2FA setup verified".to_string(),
        }))
    }

    async fn enable2_fa(
        &self,
        request: Request<Enable2FaRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let user = self.get_user_by_id(user_id).await?;

        let encrypted_secret = user
            .totp_secret
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("2FA not set up"))?;

        // Decrypt the TOTP secret for verification
        let secret = CryptoService::decrypt_totp_secret(encrypted_secret, &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to decrypt TOTP secret"))?;

        if !self.verify_totp(&secret, &req.code) {
            return Err(AppError::InvalidTwoFactorCode.into());
        }

        let backup_codes = CryptoService::generate_backup_codes(10);
        let backup_codes_hashes = CryptoService::hash_backup_codes(&backup_codes)
            .map_err(|_| Status::internal("Failed to hash backup codes"))?;

        let encrypted = CryptoService::encrypt_aes(backup_codes_hashes.as_bytes(), &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to encrypt codes"))?;

        sqlx::query("UPDATE users SET totp_enabled = TRUE, backup_codes_encrypted = $1 WHERE id = $2")
            .bind(&encrypted)
            .bind(user.id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "2FA enabled".to_string(),
        }))
    }

    async fn disable2_fa(
        &self,
        request: Request<Disable2FaRequest>,
    ) -> Result<Response<Ack>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let user = self.get_user_by_id(user_id).await?;

        if !user.totp_enabled {
            return Err(Status::failed_precondition("2FA is not enabled"));
        }

        let valid = CryptoService::verify_password(&req.code, &user.password_hash)
            .map_err(|_| Status::internal("Password verification failed"))?;

        if !valid {
            return Err(AppError::InvalidCredentials.into());
        }

        sqlx::query(
            "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, backup_codes_hash = NULL WHERE id = $1"
        )
        .bind(user.id)
        .execute(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(Ack {
            success: true,
            message: "2FA disabled".to_string(),
        }))
    }

    async fn get_backup_codes(
        &self,
        request: Request<Empty>,
    ) -> Result<Response<BackupCodesResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let user = self.get_user_by_id(user_id).await?;

        if !user.totp_enabled {
            return Err(Status::failed_precondition("2FA is not enabled"));
        }

        let encrypted = user
            .backup_codes_encrypted
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("No backup codes stored"))?;

        let decrypted = CryptoService::decrypt_aes(encrypted, &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to decrypt backup codes"))?;

        // The decrypted data is now a JSON array of argon2 hashes (not the actual codes)
        // We can't return the actual codes since they're one-way hashed
        // Return count as placeholder
        let hashes: Result<Vec<String>, _> = serde_json::from_slice(&decrypted);
        let code_count = hashes.map(|h| h.len()).unwrap_or(0);

        // Return placeholder codes — user should have saved them when enabling 2FA
        let placeholders: Vec<String> = (0..code_count).map(|i| format!("XXXX-XXXX-{:04}", i + 1)).collect();

        Ok(Response::new(BackupCodesResponse { codes: placeholders }))
    }

    async fn regenerate_backup_codes(
        &self,
        request: Request<Empty>,
    ) -> Result<Response<BackupCodesResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let user = self.get_user_by_id(user_id).await?;

        if !user.totp_enabled {
            return Err(Status::failed_precondition("2FA is not enabled"));
        }

        let codes = CryptoService::generate_backup_codes(10);
        let hashes = CryptoService::hash_backup_codes(&codes)
            .map_err(|_| Status::internal("Failed to hash backup codes"))?;

        let encrypted = CryptoService::encrypt_aes(hashes.as_bytes(), &self.state.settings.jwt_secret)
            .map_err(|_| Status::internal("Failed to encrypt codes"))?;

        sqlx::query("UPDATE users SET backup_codes_encrypted = $1 WHERE id = $2")
            .bind(&encrypted)
            .bind(user.id)
            .execute(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?;

        Ok(Response::new(BackupCodesResponse { codes }))
    }
}
