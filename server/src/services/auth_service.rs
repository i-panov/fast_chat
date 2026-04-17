//! Authentication service — business logic for auth flows.

use base32;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{Duration, Utc};
use jsonwebtoken::{encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use totp_lite::{totp, Sha1};
use uuid::Uuid;

use crate::constants::{EMAIL_CODE_EXPIRY_MINUTES, TOTP_DRIFT_TOLERANCE_SECONDS, TOTP_STEP_SECONDS};
use crate::crypto::CryptoService;
use crate::dto::auth::*;
use crate::error::AppError;
use crate::models::User;
use crate::repositories::{SessionRepository, SettingsRepository, UserRepository};

/// Authentication service handles all auth-related business logic
#[derive(Clone)]
pub struct AuthService;

impl AuthService {
    // ============ Token Generation ============

    /// Generate access and refresh tokens
    pub fn generate_tokens(
        jwt_secret: &str,
        user_id: Uuid,
        two_fa_verified: bool,
        jwt_expiry_hours: i64,
        refresh_expiry_days: i64,
    ) -> Result<(String, String), AppError> {
        let now = Utc::now();
        let expiry = now + Duration::hours(jwt_expiry_hours);

        let access_claims = Claims {
            sub: user_id.to_string(),
            exp: expiry.timestamp(),
            iat: now.timestamp(),
            two_fa_verified,
        };

        let key = EncodingKey::from_secret(jwt_secret.as_bytes());
        let access_token = encode(&Header::default(), &access_claims, &key)?;

        let refresh_expiry = now + Duration::days(refresh_expiry_days);
        let refresh_claims = Claims {
            sub: user_id.to_string(),
            exp: refresh_expiry.timestamp(),
            iat: now.timestamp(),
            two_fa_verified,
        };

        let refresh_token = encode(&Header::default(), &refresh_claims, &key)?;

        Ok((access_token, refresh_token))
    }

    /// Generate challenge token for 2FA flow
    pub fn generate_challenge_token(
        jwt_secret: &str,
        user_id: Uuid,
    ) -> Result<String, AppError> {
        let now = Utc::now();
        let expiry = now + Duration::minutes(15);

        let claims = Claims {
            sub: user_id.to_string(),
            exp: expiry.timestamp(),
            iat: now.timestamp(),
            two_fa_verified: false,
        };

        let key = EncodingKey::from_secret(jwt_secret.as_bytes());
        Ok(encode(&Header::default(), &claims, &key)?)
    }

    // ============ Email Codes ============

    /// Generate and store email verification code
    pub async fn store_email_code(
        pool: &sqlx::PgPool,
        email: &str,
    ) -> Result<String, AppError> {
        use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
        
        let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
        let salt = SaltString::generate(&mut OsRng);
        let code_hash = argon2::Argon2::default()
            .hash_password(code.as_bytes(), &salt)
            .map_err(|_| AppError::Internal)?
            .to_string();

        let expires_at = Utc::now() + Duration::minutes(EMAIL_CODE_EXPIRY_MINUTES);

        sqlx::query(
            "INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, $3) \
             ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = $3, used = FALSE",
        )
        .bind(email)
        .bind(&code_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;

        Ok(code)
    }

    /// Verify email code
    pub async fn verify_email_code(
        pool: &sqlx::PgPool,
        email: &str,
        code: &str,
    ) -> Result<(), AppError> {
        let code_record: Option<(Uuid, String, bool)> = sqlx::query_as(
            "SELECT id, code_hash, used FROM email_codes WHERE email = $1 AND expires_at > NOW()",
        )
        .bind(email)
        .fetch_optional(pool)
        .await?;

        let (code_id, code_hash, used) = code_record.ok_or(AppError::InvalidCredentials)?;

        if used {
            return Err(AppError::InvalidCredentials);
        }

        let valid = CryptoService::verify_password(code, &code_hash)
            .map_err(|_| AppError::InvalidCredentials)?;

        if !valid {
            return Err(AppError::InvalidCredentials);
        }

        // Mark as used
        sqlx::query("UPDATE email_codes SET used = TRUE WHERE id = $1")
            .bind(code_id)
            .execute(pool)
            .await?;

        Ok(())
    }

    // ============ TOTP ============

    /// Generate TOTP secret for setup
    pub fn generate_totp_secret() -> String {
        let mut secret = [0u8; 20];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &secret)
    }

    /// Verify TOTP code
    pub fn verify_totp(secret: &str, code: &str) -> bool {
        let code = code.trim().to_uppercase();

        let secret_bytes = match base32::decode(base32::Alphabet::Rfc4648 { padding: false }, secret) {
            Some(b) => b,
            None => match BASE64.decode(secret) {
                Ok(b) => b,
                Err(_) => return false,
            },
        };

        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time before UNIX epoch")
            .as_secs();

        // Check current window ± drift tolerance
        code == totp::<Sha1>(&secret_bytes, seconds)
            || code == totp::<Sha1>(&secret_bytes, seconds.saturating_sub(TOTP_DRIFT_TOLERANCE_SECONDS))
            || code == totp::<Sha1>(&secret_bytes, seconds.saturating_add(TOTP_DRIFT_TOLERANCE_SECONDS))
    }

    // ============ Backup Codes ============

    /// Remove a used backup code
    pub async fn remove_used_backup_code(
        pool: &sqlx::PgPool,
        user_id: Uuid,
        code: &str,
        jwt_secret: &str,
    ) -> Result<(), AppError> {
        let encrypted: String =
            sqlx::query_scalar("SELECT backup_codes_encrypted FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(pool)
                .await?
                .ok_or_else(|| AppError::Validation("No backup codes found".into()))?;

        let decrypted = CryptoService::decrypt_aes(&encrypted, jwt_secret)
            .map_err(|_| AppError::Internal)?;
        let hashes_json = String::from_utf8(decrypted).map_err(|_| AppError::Internal)?;

        let idx = CryptoService::verify_backup_code_and_get_index(code, &hashes_json)
            .map_err(|_| AppError::InvalidTwoFactorCode)?;

        let hashes: Vec<String> = serde_json::from_str(&hashes_json).map_err(|_| AppError::Internal)?;

        let new_hashes: Vec<String> = hashes
            .into_iter()
            .enumerate()
            .filter(|(i, _)| *i != idx)
            .map(|(_, h)| h)
            .collect();

        if new_hashes.len() < 3 {
            return Err(AppError::Validation(
                "Cannot reduce below 3 backup codes. Regenerate instead.".into(),
            ));
        }

        let new_hashes_json = serde_json::to_string(&new_hashes).map_err(|_| AppError::Internal)?;
        let new_encrypted = CryptoService::encrypt_aes(new_hashes_json.as_bytes(), jwt_secret)
            .map_err(|_| AppError::Internal)?;

        sqlx::query("UPDATE users SET backup_codes_encrypted = $1 WHERE id = $2")
            .bind(&new_encrypted)
            .bind(user_id)
            .execute(pool)
            .await?;

        Ok(())
    }

    // ============ Session Management ============

    /// Hash refresh token for storage
    pub fn hash_refresh_token(token: &str) -> String {
        let hash = Sha256::digest(token.as_bytes());
        BASE64.encode(hash)
    }

    /// Store refresh token in session
    pub async fn store_refresh_token(
        pool: &sqlx::PgPool,
        user_id: Uuid,
        token: &str,
        expiry_days: i64,
    ) -> Result<(), AppError> {
        let token_hash = Self::hash_refresh_token(token);
        let session_id = uuid::Uuid::new_v4();
        let expires_at = Utc::now() + Duration::days(expiry_days);

        sqlx::query(
            "INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(session_id)
        .bind(user_id)
        .bind(&token_hash)
        .bind(expires_at)
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Validate refresh token
    pub async fn validate_refresh_token(
        pool: &sqlx::PgPool,
        token: &str,
        jwt_secret: &str,
    ) -> Result<(Uuid, bool), AppError> {
        use jsonwebtoken::{decode, DecodingKey, Validation};
        use crate::middleware::jwt::JwtClaims;

        let token_hash = Self::hash_refresh_token(token);
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "SELECT user_id FROM user_sessions WHERE refresh_token_hash = $1 AND expires_at > NOW()"
        )
        .bind(&token_hash)
        .fetch_optional(pool)
        .await?;

        let user_id = user_id.ok_or(AppError::InvalidToken)?;

        // Decode token to get 2FA status
        let key = DecodingKey::from_secret(jwt_secret.as_bytes());
        let token_data = decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256))
            .map_err(|_| AppError::InvalidToken)?;

        Ok((user_id, token_data.claims.two_fa_verified))
    }

    // ============ User Creation ============

    /// Create new user for registration
    pub async fn create_user(
        pool: &sqlx::PgPool,
        email: &str,
    ) -> Result<User, AppError> {
        let id = uuid::Uuid::new_v4();
        let now = Utc::now();
        let base_username = email.split('@').next().unwrap_or("user").to_string();
        let (public_key, _) = CryptoService::generate_keypair();

        sqlx::query(
            "INSERT INTO users (id, username, email, public_key, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (email) DO NOTHING",
        )
        .bind(id)
        .bind(&base_username)
        .bind(email)
        .bind(&public_key)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
            .bind(email)
            .fetch_one(pool)
            .await
            .map_err(Into::into)
    }
}

/// JWT Claims struct (shared with middleware)
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
    pub iat: i64,
    pub two_fa_verified: bool,
}
