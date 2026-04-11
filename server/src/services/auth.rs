use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::middleware::get_user_id_from_request;
use crate::proto::auth::{AuthResponse, LoginRequest, RefreshRequest, RegisterRequest};
use crate::proto::common::{Empty, User as ProtoUser};
use crate::{crypto::CryptoService, error::AppError, AppState};

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: i64,
    iat: i64,
}

pub struct AuthService {
    state: Arc<AppState>,
}

impl AuthService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    /// Remove a used backup code from the user's encrypted store
    async fn remove_used_backup_code(
        &self,
        user_id: uuid::Uuid,
        used_code: &str,
    ) -> Result<(), AppError> {
        let encrypted: Option<String> =
            sqlx::query_scalar("SELECT backup_codes_encrypted FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(self.state.db.get_pool())
                .await?
                .flatten();

        if let Some(enc) = encrypted {
            if let Ok(decrypted) =
                CryptoService::decrypt_aes(&enc, &self.state.settings.jwt_secret)
            {
                // The encrypted data is now a JSON array of argon2 hashes
                if let Ok(hashes_json) = String::from_utf8(decrypted) {
                    if let Ok(mut hashes) = serde_json::from_slice::<Vec<String>>(hashes_json.as_bytes()) {
                        // Find and remove the hash that matches the used code
                        if let Some(idx) = hashes.iter().position(|h| {
                            CryptoService::verify_backup_code(used_code, h)
                                .unwrap_or(false)
                        }) {
                            hashes.remove(idx);

                            // Re-encrypt remaining hashes
                            let new_json =
                                serde_json::to_string(&hashes).map_err(AppError::Serialization)?;
                            let new_encrypted =
                                CryptoService::encrypt_aes(new_json.as_bytes(), &self.state.settings.jwt_secret)
                                    .map_err(|_| AppError::Internal)?;

                            sqlx::query(
                                "UPDATE users SET backup_codes_encrypted = $1 WHERE id = $2",
                            )
                            .bind(&new_encrypted)
                            .bind(user_id)
                            .execute(self.state.db.get_pool())
                            .await?;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn generate_tokens(&self, user_id: Uuid) -> Result<(String, String), AppError> {
        let now = Utc::now();
        let expiry = now + Duration::hours(self.state.settings.jwt_expiry_hours);

        let access_claims = Claims {
            sub: user_id.to_string(),
            exp: expiry.timestamp(),
            iat: now.timestamp(),
        };

        let key = EncodingKey::from_secret(self.state.settings.jwt_secret.as_bytes());
        let access_token = encode(&Header::new(Algorithm::HS256), &access_claims, &key)?;

        let refresh_expiry = now + Duration::days(7);
        let refresh_claims = Claims {
            sub: user_id.to_string(),
            exp: refresh_expiry.timestamp(),
            iat: now.timestamp(),
        };

        let refresh_token = encode(&Header::new(Algorithm::HS256), &refresh_claims, &key)?;

        Ok((access_token, refresh_token))
    }

    /// Hash a refresh token for secure storage
    fn hash_refresh_token(token: &str) -> String {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(token.as_bytes());
        BASE64.encode(hash)
    }

    /// Store a refresh token session in the database
    async fn store_refresh_token(&self, user_id: Uuid, token: &str) -> Result<(), AppError> {
        let token_hash = Self::hash_refresh_token(token);
        let session_id = uuid::Uuid::new_v4();
        let expires_at = Utc::now() + Duration::days(7);

        sqlx::query(
            "INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(session_id)
        .bind(user_id)
        .bind(&token_hash)
        .bind(expires_at)
        .execute(self.state.db.get_pool())
        .await?;

        Ok(())
    }

    /// Validate that a refresh token exists in the database and hasn't expired
    async fn validate_refresh_token(&self, token: &str) -> Result<Uuid, AppError> {
        let token_hash = Self::hash_refresh_token(token);

        // First validate JWT signature
        let user_id = self.validate_token(token)?;

        // Then check DB for active session
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM user_sessions WHERE refresh_token_hash = $1 AND expires_at > NOW())",
        )
        .bind(&token_hash)
        .fetch_one(self.state.db.get_pool())
        .await?;

        if !exists {
            return Err(AppError::InvalidToken);
        }

        Ok(user_id)
    }

    fn validate_token(&self, token: &str) -> Result<Uuid, AppError> {
        let key = DecodingKey::from_secret(self.state.settings.jwt_secret.as_bytes());
        let token_data = decode::<Claims>(token, &key, &Validation::new(Algorithm::HS256))?;

        let user_id: Uuid = token_data
            .claims
            .sub
            .parse()
            .map_err(|_| AppError::InvalidToken)?;
        Ok(user_id)
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

    fn verify_backup_code(&self, code: &str, _stored_hash: &str, encrypted: Option<&str>) -> bool {
        // Use the new individual code verification from encrypted codes
        if let Some(enc) = encrypted {
            if let Ok(decrypted) = CryptoService::decrypt_aes(enc, &self.state.settings.jwt_secret) {
                if let Ok(hashes_json) = String::from_utf8(decrypted) {
                    if let Ok(valid) = CryptoService::verify_backup_code(code, &hashes_json) {
                        return valid;
                    }
                }
            }
        }

        // Fallback to legacy hash verification
        let codes: Vec<String> = code.split('|').map(|s| s.to_string()).collect();
        CryptoService::verify_backup_codes_legacy(&codes, _stored_hash).unwrap_or(false)
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
}

#[tonic::async_trait]
impl crate::proto::auth::auth_server::Auth for AuthService {
    async fn register(
        &self,
        _request: Request<RegisterRequest>,
    ) -> Result<Response<AuthResponse>, Status> {
        Err(Status::unimplemented(
            "Registration is disabled. Users are created by admin.",
        ))
    }

    async fn login(
        &self,
        request: Request<LoginRequest>,
    ) -> Result<Response<AuthResponse>, Status> {
        let req = request.into_inner();

        let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE username = $1")
            .bind(&req.username)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::InvalidCredentials)?;

        if user.disabled {
            return Err(AppError::InvalidCredentials.into());
        }

        let valid = CryptoService::verify_password(&req.password, &user.password_hash)
            .map_err(|_| Status::internal("Password verification failed"))?;

        if !valid {
            return Err(AppError::InvalidCredentials.into());
        }

        if user.require_2fa || user.totp_enabled {
            if req.totp_code.is_empty() {
                return Err(Status::unauthenticated("2FA required"));
            }

            let encrypted_secret = user
                .totp_secret
                .as_ref()
                .ok_or_else(|| Status::unauthenticated("2FA not configured"))?;

            // Decrypt the TOTP secret
            let secret = CryptoService::decrypt_totp_secret(encrypted_secret, &self.state.settings.jwt_secret)
                .map_err(|_| Status::internal("Failed to decrypt TOTP secret"))?;

            if !self.verify_totp(&secret, &req.totp_code) {
                // Try backup code
                let backup_encrypted = user.backup_codes_encrypted.as_deref();
                if let Some(hash) = &user.backup_codes_hash {
                    let valid_backup =
                        self.verify_backup_code(&req.totp_code, hash, backup_encrypted);
                    if !valid_backup {
                        return Err(AppError::InvalidTwoFactorCode.into());
                    }

                    // Remove used backup code
                    if backup_encrypted.is_some() {
                        self.remove_used_backup_code(user.id, &req.totp_code)
                            .await
                            .map_err(|e| {
                                tracing::error!("Failed to remove used backup code: {}", e);
                                AppError::Internal
                            })?;
                    }
                } else {
                    return Err(AppError::InvalidTwoFactorCode.into());
                }
            }
        }

        let (access_token, refresh_token) = self.generate_tokens(user.id)?;

        // Store refresh token session in DB
        self.store_refresh_token(user.id, &refresh_token).await?;

        Ok(Response::new(AuthResponse {
            access_token,
            refresh_token,
            user: Some(self.user_to_proto(&user)),
            expires_at: None,
        }))
    }

    async fn refresh_token(
        &self,
        request: Request<RefreshRequest>,
    ) -> Result<Response<AuthResponse>, Status> {
        let req = request.into_inner();

        // Validate refresh token against DB (checks both JWT signature and active session)
        let user_id = self
            .validate_refresh_token(&req.refresh_token)
            .await
            .map_err(|_| AppError::InvalidToken)?;

        let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::UserNotFound)?;

        if user.disabled {
            return Err(AppError::InvalidCredentials.into());
        }

        let (access_token, refresh_token) = self.generate_tokens(user.id)?;

        // Store new refresh token session (rotating tokens)
        self.store_refresh_token(user.id, &refresh_token).await?;

        Ok(Response::new(AuthResponse {
            access_token,
            refresh_token,
            user: Some(self.user_to_proto(&user)),
            expires_at: None,
        }))
    }

    async fn get_current_user(
        &self,
        request: Request<Empty>,
    ) -> Result<Response<ProtoUser>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let user = sqlx::query_as::<_, crate::models::User>("SELECT * FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::UserNotFound)?;

        Ok(Response::new(self.user_to_proto(&user)))
    }
}
