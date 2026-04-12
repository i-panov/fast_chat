use axum::extract::State;
use axum::{
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use base32;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use totp_lite::{totp, Sha1};
use uuid::Uuid;

use crate::{
    crypto::CryptoService, error::AppError, middleware::jwt::get_user_id_from_request,
    models::User, routes::dto::UserResponse, AppState,
};

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: i64,
    iat: i64,
    two_fa_verified: bool,
}

#[derive(Debug, Deserialize)]
pub struct RequestCodeRequest {
    pub email: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyCodeRequest {
    pub email: String,
    pub code: String,
    pub totp_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Verify2faRequest {
    pub user_id: String,
    pub totp_code: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

fn generate_tokens(
    state: &AppState,
    user_id: Uuid,
    two_fa_verified: bool,
) -> Result<(String, String), AppError> {
    let now = Utc::now();
    let expiry = now + Duration::hours(state.settings.jwt_expiry_hours);

    let access_claims = Claims {
        sub: user_id.to_string(),
        exp: expiry.timestamp(),
        iat: now.timestamp(),
        two_fa_verified,
    };

    let key = EncodingKey::from_secret(state.settings.jwt_secret.as_bytes());
    let access_token = encode(&Header::default(), &access_claims, &key)?;

    let refresh_expiry = now + Duration::days(state.settings.refresh_token_expiry_days);
    let refresh_claims = Claims {
        sub: user_id.to_string(),
        exp: refresh_expiry.timestamp(),
        iat: now.timestamp(),
        two_fa_verified,
    };

    let refresh_token = encode(&Header::default(), &refresh_claims, &key)?;

    Ok((access_token, refresh_token))
}

fn hash_refresh_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(token.as_bytes());
    BASE64.encode(hash)
}

pub async fn store_refresh_token(
    state: &AppState,
    user_id: Uuid,
    token: &str,
) -> Result<(), AppError> {
    let token_hash = hash_refresh_token(token);
    let session_id = uuid::Uuid::new_v4();
    let expires_at = Utc::now() + Duration::days(state.settings.refresh_token_expiry_days);

    sqlx::query(
        "INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(state.db.get_pool())
    .await?;

    Ok(())
}

/// Generate a 6-digit code and store its argon2 hash.
/// Always overwrites any existing code — the user always sees the latest code
/// that was returned, so the DB must match what they see on screen.
pub async fn store_email_code(state: &AppState, email: &str) -> Result<String, AppError> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
    let salt = SaltString::generate(&mut OsRng);
    let code_hash = argon2::Argon2::default()
        .hash_password(code.as_bytes(), &salt)
        .map_err(|_| AppError::Internal)?
        .to_string();

    let expires_at = Utc::now() + Duration::minutes(10);

    sqlx::query(
        "INSERT INTO email_codes (email, code_hash, expires_at) VALUES ($1, $2, $3) \
         ON CONFLICT (email) DO UPDATE SET code_hash = $2, expires_at = $3, used = FALSE",
    )
    .bind(email)
    .bind(&code_hash)
    .bind(expires_at)
    .execute(state.db.get_pool())
    .await?;

    Ok(code)
}

fn verify_totp(secret: &str, code: &str) -> bool {
    // Normalize: strip spaces, uppercase
    let code = code.trim().to_uppercase();

    let secret_bytes = match base32::decode(base32::Alphabet::Rfc4648 { padding: false }, secret) {
        Some(b) => b,
        None => match BASE64.decode(secret) {
            Ok(b) => b, // fallback for legacy Base64 secrets
            Err(_) => return false,
        },
    };

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    let expected = totp::<Sha1>(&secret_bytes, seconds);

    // Check current window ± 1 step (30s drift tolerance)
    code == expected
        || {
            let prev = totp::<Sha1>(&secret_bytes, seconds - 30);
            code == prev
        }
        || {
            let next = totp::<Sha1>(&secret_bytes, seconds + 30);
            code == next
        }
}

/// Remove a used backup code from the user's stored list.
/// Returns Err if the code is invalid or would leave fewer than 3 codes.
pub async fn remove_used_backup_code(
    state: &AppState,
    user_id: Uuid,
    code: &str,
) -> Result<(), AppError> {
    let encrypted: String =
        sqlx::query_scalar("SELECT backup_codes_encrypted FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(state.db.get_pool())
            .await?
            .ok_or_else(|| AppError::Validation("No backup codes found".into()))?;

    let hashes_json = CryptoService::decrypt_aes(&encrypted, &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;
    let hashes_json = String::from_utf8(hashes_json).map_err(|_| AppError::Internal)?;

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
    let new_encrypted =
        CryptoService::encrypt_aes(new_hashes_json.as_bytes(), &state.settings.jwt_secret)
            .map_err(|_| AppError::Internal)?;

    sqlx::query("UPDATE users SET backup_codes_encrypted = $1 WHERE id = $2")
        .bind(&new_encrypted)
        .bind(user_id)
        .execute(state.db.get_pool())
        .await?;

    Ok(())
}

/// POST /api/auth/request-code
/// Send a one-time code to the user's email.
/// If registration is enabled, creates account for new users automatically on verify.
pub async fn request_code(
    State(state): State<std::sync::Arc<AppState>>,
    Json(req): Json<RequestCodeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!("request_code called for email: {}", req.email);

    let email = req.email.trim().to_lowercase();

    // Check if user exists
    let user_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)")
            .bind(&email)
            .fetch_one(state.db.get_pool())
            .await?;

    // If registration is disabled and user doesn't exist — reject
    if !user_exists && !state.settings.allow_registration {
        tracing::warn!("Registration disabled for email: {}", email);
        return Err(AppError::NotAuthorized);
    }

    // Generate and store code
    let code = store_email_code(&state, &email).await?;

    // In production, send email via SMTP/Mailgun/etc.
    // For now, log it (dev mode)
    tracing::info!("Email code for {}: {}", email, code);

    Ok(Json(serde_json::json!({
        "message": "Verification code sent to email",
        "dev_code": code, // Remove in production!
    })))
}

/// POST /api/auth/verify-code
/// Verify the email code. Creates account if registration is enabled.
pub async fn verify_code(
    State(state): State<std::sync::Arc<AppState>>,
    Json(req): Json<VerifyCodeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    tracing::info!("verify_code called for email: {}", req.email);

    let email = req.email.trim().to_lowercase();

    // Atomically claim the code: UPDATE returns id only if code was unused
    // This prevents race conditions where two requests verify the same code
    let used_id: Option<Uuid> = sqlx::query_scalar(
        "UPDATE email_codes SET used = TRUE WHERE email = $1 AND expires_at > NOW() AND used = FALSE RETURNING id",
    )
    .bind(&email)
    .fetch_optional(state.db.get_pool())
    .await?;

    let code_id = match used_id {
        Some(id) => id,
        None => {
            // Debug: check if code exists at all
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM email_codes WHERE email = $1)")
                    .bind(&email)
                    .fetch_one(state.db.get_pool())
                    .await?;

            let expired: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM email_codes WHERE email = $1 AND expires_at <= NOW())",
            )
            .bind(&email)
            .fetch_one(state.db.get_pool())
            .await?;

            let already_used: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM email_codes WHERE email = $1 AND used = TRUE)",
            )
            .bind(&email)
            .fetch_one(state.db.get_pool())
            .await?;

            tracing::error!(
                "Code not found for {}: exists={}, expired={}, used={}",
                email,
                exists,
                expired,
                already_used
            );
            return Err(AppError::InvalidCredentials);
        }
    };

    // Fetch the code hash AFTER claiming it (to verify the specific code)
    let code_hash: String = sqlx::query_scalar("SELECT code_hash FROM email_codes WHERE id = $1")
        .bind(code_id)
        .fetch_one(state.db.get_pool())
        .await?;

    let valid = CryptoService::verify_password(&req.code, &code_hash)
        .map_err(|_| AppError::InvalidCredentials)?;

    if !valid {
        return Err(AppError::InvalidCredentials);
    }

    // Fetch user (might not exist if registration is enabled)
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(state.db.get_pool())
        .await?;

    let user = match user {
        Some(u) => u,
        None => {
            // Registration is enabled — create account
            if !state.settings.allow_registration {
                return Err(AppError::UserNotFound);
            }

            let id = uuid::Uuid::new_v4();
            let now = Utc::now();
            let base_username = email.split('@').next().unwrap_or("user").to_string();
            let (public_key, _) = CryptoService::generate_keypair();

            // Insert; if email already exists, ignore (user already exists)
            sqlx::query(
                "INSERT INTO users (id, username, email, public_key, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6) \
                 ON CONFLICT (email) DO NOTHING",
            )
            .bind(id)
            .bind(&base_username)
            .bind(&email)
            .bind(&public_key)
            .bind(now)
            .bind(now)
            .execute(state.db.get_pool())
            .await?;

            sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
                .bind(&email)
                .fetch_one(state.db.get_pool())
                .await?
        }
    };

    if user.disabled {
        return Err(AppError::InvalidCredentials);
    }

    // Admins must always have TOTP enabled (unless disabled via env)
    if user.is_admin && !user.totp_enabled && !state.settings.allow_admin_no_2fa {
        return Ok(Json(serde_json::json!({
            "need_2fa": true,
            "require_2fa": true,
            "user_id": user.id.to_string(),
            "message": "Admin accounts require 2FA. Please set up TOTP first.",
        })));
    }

    // Check server-level require_2fa (from DB, fallback to env default)
    let require_2fa_db: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_settings WHERE key = 'require_2fa'")
            .fetch_optional(state.db.get_pool())
            .await
            .ok()
            .flatten();
    let require_2fa_globally = require_2fa_db.as_deref() == Some("true")
        || (require_2fa_db.is_none() && state.settings.require_2fa);

    let needs_2fa = user.totp_enabled || require_2fa_globally;

    // If TOTP provided and needed
    if let (true, Some(ref totp_code)) = (needs_2fa, &req.totp_code) {
        if user.totp_enabled {
            let encrypted_secret = user
                .totp_secret
                .as_ref()
                .ok_or(AppError::TwoFactorNotConfigured)?;

            let secret =
                CryptoService::decrypt_totp_secret(encrypted_secret, &state.settings.jwt_secret)
                    .map_err(|_| AppError::Internal)?;

            if !verify_totp(&secret, totp_code) {
                // Try backup code
                if let Some(enc) = &user.backup_codes_encrypted {
                    if let Ok(decrypted) =
                        CryptoService::decrypt_aes(enc, &state.settings.jwt_secret)
                    {
                        if let Ok(hashes_json) = String::from_utf8(decrypted) {
                            if let Ok(valid) =
                                CryptoService::verify_backup_code(totp_code, &hashes_json)
                            {
                                if !valid {
                                    return Err(AppError::InvalidTwoFactorCode);
                                }
                                remove_used_backup_code(&state, user.id, totp_code).await?;
                            } else {
                                return Err(AppError::InvalidTwoFactorCode);
                            }
                        } else {
                            return Err(AppError::InvalidTwoFactorCode);
                        }
                    } else {
                        return Err(AppError::InvalidTwoFactorCode);
                    }
                } else {
                    return Err(AppError::InvalidTwoFactorCode);
                }
            }
        } else if require_2fa_globally && !user.totp_enabled {
            // Server requires 2FA but user hasn't set it up yet
            return Ok(Json(serde_json::json!({
                "need_2fa": true,
                "require_2fa": true,
                "user_id": user.id.to_string(),
                "message": "2FA is required. Please set up TOTP first.",
            })));
        }

        // All verified — issue tokens
        let (access_token, refresh_token) = generate_tokens(&state, user.id, true)?;
        store_refresh_token(&state, user.id, &refresh_token).await?;

        return Ok(Json(serde_json::json!({
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user": UserResponse::from(&user),
        })));
    }

    if needs_2fa {
        return Ok(Json(serde_json::json!({
            "need_2fa": true,
            "require_2fa": require_2fa_globally && !user.totp_enabled,
            "user_id": user.id.to_string(),
        })));
    }

    // No 2FA needed — issue tokens
    let (access_token, refresh_token) = generate_tokens(&state, user.id, true)?;
    store_refresh_token(&state, user.id, &refresh_token).await?;

    Ok(Json(serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": UserResponse::from(&user),
    })))
}

/// POST /api/auth/verify-2fa
/// Completes 2FA flow after verify-code returned need_2fa.
pub async fn verify_2fa(
    State(state): State<std::sync::Arc<AppState>>,
    Json(req): Json<Verify2faRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user_id: Uuid = req.user_id.parse().map_err(|_| AppError::UserNotFound)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    if user.disabled {
        return Err(AppError::InvalidCredentials);
    }

    if user.totp_enabled {
        let encrypted_secret = user
            .totp_secret
            .as_ref()
            .ok_or(AppError::TwoFactorNotConfigured)?;

        let secret =
            CryptoService::decrypt_totp_secret(encrypted_secret, &state.settings.jwt_secret)
                .map_err(|_| AppError::Internal)?;

        if !verify_totp(&secret, &req.totp_code) {
            // Try backup code
            if let Some(enc) = &user.backup_codes_encrypted {
                if let Ok(decrypted) = CryptoService::decrypt_aes(enc, &state.settings.jwt_secret) {
                    if let Ok(hashes_json) = String::from_utf8(decrypted) {
                        if let Ok(valid) =
                            CryptoService::verify_backup_code(&req.totp_code, &hashes_json)
                        {
                            if !valid {
                                return Err(AppError::InvalidTwoFactorCode);
                            }
                            remove_used_backup_code(&state, user.id, &req.totp_code).await?;
                        } else {
                            return Err(AppError::InvalidTwoFactorCode);
                        }
                    } else {
                        return Err(AppError::InvalidTwoFactorCode);
                    }
                } else {
                    return Err(AppError::InvalidTwoFactorCode);
                }
            } else {
                return Err(AppError::InvalidTwoFactorCode);
            }
        }
    } else if state.settings.require_2fa {
        // Server requires 2FA but user hasn't set it up
        return Ok(Json(serde_json::json!({
            "need_2fa": true,
            "require_2fa": true,
            "user_id": user.id.to_string(),
            "message": "2FA is required. Please set up TOTP first.",
        })));
    }

    let two_fa_verified = user.totp_enabled;

    let (access_token, refresh_token) = generate_tokens(&state, user.id, two_fa_verified)?;
    store_refresh_token(&state, user.id, &refresh_token).await?;

    Ok(Json(serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": UserResponse::from(&user),
    })))
}

/// POST /api/auth/refresh
pub async fn refresh_token(
    State(state): State<std::sync::Arc<AppState>>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let token_hash = hash_refresh_token(&req.refresh_token);

    let key = DecodingKey::from_secret(state.settings.jwt_secret.as_bytes());
    let token_data = decode::<Claims>(&req.refresh_token, &key, &Validation::new(Algorithm::HS256))
        .map_err(|_| AppError::InvalidToken)?;
    let user_id: Uuid = token_data
        .claims
        .sub
        .parse()
        .map_err(|_| AppError::InvalidToken)?;
    let two_fa_verified = token_data.claims.two_fa_verified;

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM user_sessions WHERE refresh_token_hash = $1 AND expires_at > NOW())",
    )
    .bind(&token_hash)
    .fetch_one(state.db.get_pool())
    .await?;

    if !exists {
        return Err(AppError::InvalidToken);
    }

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    if user.disabled {
        return Err(AppError::InvalidCredentials);
    }

    let (access_token, refresh_token) = generate_tokens(&state, user.id, two_fa_verified)?;
    store_refresh_token(&state, user.id, &refresh_token).await?;

    Ok(Json(serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": UserResponse::from(&user),
    })))
}

/// GET /api/auth/me
pub async fn get_current_user(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<UserResponse>, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;

    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    Ok(Json(UserResponse::from(&user)))
}

/// Extract user_id from JWT header OR from request body (for 2FA setup flow)
fn extract_user_id_or_body(
    headers: &HeaderMap,
    body_user_id: Option<&str>,
    jwt_secret: &str,
) -> Result<Uuid, AppError> {
    // Try JWT first
    if let Some(auth_header) = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Ok(uid) = get_user_id_from_request(auth_header, jwt_secret) {
            return Ok(uid);
        }
    }
    // Fallback to body
    body_user_id
        .and_then(|s| s.parse().ok())
        .ok_or(AppError::InvalidToken)
}

/// POST /api/auth/2fa/setup
/// Generates TOTP secret (doesn't enable it yet)
pub async fn setup_2fa(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let body_user_id = body["user_id"].as_str();
    let user_id = extract_user_id_or_body(&headers, body_user_id, &state.settings.jwt_secret)?;

    let secret = generate_totp_secret();
    let encrypted_secret = CryptoService::encrypt_totp_secret(&secret, &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;
    sqlx::query("UPDATE users SET totp_secret = $1 WHERE id = $2")
        .bind(&encrypted_secret)
        .bind(user_id)
        .execute(state.db.get_pool())
        .await?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    let qr_code_url = format!(
        "otpauth://totp/FastChat:{}?secret={}",
        user.username, secret
    );

    Ok(Json(serde_json::json!({
        "secret": secret,
        "qr_code_url": qr_code_url,
    })))
}

/// POST /api/auth/2fa/verify-setup
/// Verify TOTP code after setup (doesn't enable yet)
pub async fn verify_2fa_setup(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let body_user_id = body["user_id"].as_str();
    let user_id = extract_user_id_or_body(&headers, body_user_id, &state.settings.jwt_secret)?;

    let code = body["code"]
        .as_str()
        .ok_or(AppError::Validation("code is required".to_string()))?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    let encrypted_secret = user
        .totp_secret
        .as_ref()
        .ok_or(AppError::TwoFactorNotConfigured)?;
    let secret = CryptoService::decrypt_totp_secret(encrypted_secret, &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    let secret_bytes =
        base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &secret).unwrap_or_default();
    let expected = totp::<Sha1>(&secret_bytes, seconds);
    tracing::info!(
        "TOTP debug: secret={} ({} bytes), time={}, expected_code={}, user_code={}",
        secret.chars().take(12).collect::<String>(),
        secret.len(),
        seconds,
        expected,
        code
    );

    if !verify_totp(&secret, code) {
        return Err(AppError::InvalidTwoFactorCode);
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "2FA setup verified. Call /2fa/enable to activate.",
    })))
}

/// POST /api/auth/2fa/enable
/// Verify TOTP one more time and enable 2FA with backup codes
pub async fn enable_2fa(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let body_user_id = body["user_id"].as_str();
    let user_id = extract_user_id_or_body(&headers, body_user_id, &state.settings.jwt_secret)?;

    let code = body["code"]
        .as_str()
        .ok_or(AppError::Validation("code is required".to_string()))?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    let encrypted_secret = user
        .totp_secret
        .as_ref()
        .ok_or(AppError::TwoFactorNotConfigured)?;
    let secret = CryptoService::decrypt_totp_secret(encrypted_secret, &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    let secret_bytes =
        base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &secret).unwrap_or_default();
    let expected = totp::<Sha1>(&secret_bytes, seconds);
    tracing::info!(
        "TOTP debug: secret={} ({} bytes), time={}, expected_code={}, user_code={}",
        secret.chars().take(12).collect::<String>(),
        secret.len(),
        seconds,
        expected,
        code
    );

    if !verify_totp(&secret, code) {
        return Err(AppError::InvalidTwoFactorCode);
    }

    let codes = CryptoService::generate_backup_codes(10);
    let hashes = CryptoService::hash_backup_codes(&codes).map_err(|_| AppError::Internal)?;
    let encrypted = CryptoService::encrypt_aes(hashes.as_bytes(), &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;

    sqlx::query("UPDATE users SET totp_enabled = TRUE, backup_codes_encrypted = $1 WHERE id = $2")
        .bind(&encrypted)
        .bind(user_id)
        .execute(state.db.get_pool())
        .await?;

    // Re-fetch user to get updated state
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    // Issue tokens since 2FA is now verified
    let (access_token, refresh_token) = generate_tokens(&state, user.id, true)?;
    store_refresh_token(&state, user.id, &refresh_token).await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "2FA enabled",
        "backup_codes": codes,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": UserResponse::from(&user),
    })))
}

/// POST /api/auth/2fa/disable — requires email code verification
pub async fn disable_2fa(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    let email = body["email"]
        .as_str()
        .ok_or(AppError::Validation("email is required".to_string()))?;
    let code = body["code"]
        .as_str()
        .ok_or(AppError::Validation("code is required".to_string()))?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    if !user.totp_enabled {
        return Err(AppError::TwoFactorNotConfigured);
    }

    // Verify email code
    let code_record: Option<(String, bool)> = sqlx::query_as(
        "SELECT code_hash, used FROM email_codes WHERE email = $1 AND expires_at > NOW()",
    )
    .bind(email)
    .fetch_optional(state.db.get_pool())
    .await?;

    let (code_hash, was_used) = code_record.ok_or(AppError::InvalidCredentials)?;

    if was_used {
        return Err(AppError::InvalidCredentials);
    }

    let valid = CryptoService::verify_password(code, &code_hash)
        .map_err(|_| AppError::InvalidCredentials)?;

    if !valid {
        return Err(AppError::InvalidCredentials);
    }

    sqlx::query("UPDATE email_codes SET used = TRUE WHERE email = $1")
        .bind(email)
        .execute(state.db.get_pool())
        .await?;

    sqlx::query(
        "UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, backup_codes_encrypted = NULL WHERE id = $1"
    )
    .bind(user.id)
    .execute(state.db.get_pool())
    .await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "2FA disabled",
    })))
}

/// GET /api/auth/2fa/backup-codes
pub async fn get_backup_codes(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    if !user.totp_enabled {
        return Err(AppError::TwoFactorNotConfigured);
    }

    Ok(Json(serde_json::json!({
        "codes": ["XXXX-XXXX (backup codes are one-way hashed and not retrievable)"]
    })))
}

/// POST /api/auth/2fa/backup-codes/regenerate
pub async fn regenerate_backup_codes(
    State(state): State<std::sync::Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    let user_id = get_user_id_from_request(auth_header, &state.settings.jwt_secret)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::UserNotFound)?;

    if !user.totp_enabled {
        return Err(AppError::TwoFactorNotConfigured);
    }

    let codes = CryptoService::generate_backup_codes(10);
    let hashes = CryptoService::hash_backup_codes(&codes).map_err(|_| AppError::Internal)?;
    let encrypted = CryptoService::encrypt_aes(hashes.as_bytes(), &state.settings.jwt_secret)
        .map_err(|_| AppError::Internal)?;

    sqlx::query("UPDATE users SET backup_codes_encrypted = $1 WHERE id = $2")
        .bind(&encrypted)
        .bind(user.id)
        .execute(state.db.get_pool())
        .await?;

    Ok(Json(serde_json::json!({ "codes": codes })))
}

fn generate_totp_secret() -> String {
    use rand::RngCore;
    let mut secret = [0u8; 20];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &secret)
}
