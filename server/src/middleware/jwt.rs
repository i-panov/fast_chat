use axum::{
    extract::{Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::Response,
    Json,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

use crate::constants;
use crate::{error::AppError, AppState};

/// JWT Claims structure
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JwtClaims {
    pub sub: String,
    pub exp: i64,
    pub iat: i64,
    /// If true, user passed 2FA verification. Required for 2FA-enabled accounts.
    #[serde(default)]
    pub two_fa_verified: bool,
}

/// Typed extractor for authenticated user ID.
/// Use as: `UserId(user_id): UserId` in route handlers.
pub struct UserId(pub Uuid);

impl<S> axum::extract::FromRequestParts<S> for UserId
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<Uuid>().copied().map(UserId).ok_or((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Not authenticated"})),
        ))
    }
}

/// JWT middleware — validates token and puts user_id into request extensions.
/// Optimized: uses cached server settings instead of DB query on every request.
pub async fn jwt_auth(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    // Extract Authorization header
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Missing Authorization header"})),
        ))?;

    let token = auth_header.strip_prefix("Bearer ").ok_or((
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "Invalid Authorization header format"})),
    ))?;

    // Decode JWT token
    let key = DecodingKey::from_secret(state.settings.jwt_secret.as_bytes());
    let token_data =
        decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256)).map_err(|e| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": e.to_string()})),
            )
        })?;

    let user_id: Uuid = token_data.claims.sub.parse().map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Invalid token subject"})),
        )
    })?;

    let two_fa_verified = token_data.claims.two_fa_verified;

    // Use cached settings instead of DB query
    let require_2fa_global = {
        let cache = state.settings_cache.read().unwrap();
        cache.require_2fa
    };

    // Check user 2FA status (single optimized query)
    let user_row: Option<(bool, bool)> =
        sqlx::query_as("SELECT is_admin, COALESCE(totp_enabled, FALSE) FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(state.db.get_pool())
            .await
            .map_err(|e| {
                tracing::error!("JWT auth user lookup failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "Internal server error"})),
                )
            })?;
    let (is_admin, totp_enabled) = user_row.unwrap_or((false, false));

    // Admins always require 2FA, or global setting
    let need_2fa = is_admin || require_2fa_global;

    if !two_fa_verified {
        if need_2fa {
            return Err((
                StatusCode::PRECONDITION_FAILED,
                Json(json!({"error": "2FA verification required", "need_2fa": true})),
            ));
        }
    } else if need_2fa && !totp_enabled {
        // Even if token claims verified, re-check if user disabled 2FA but now required
        return Err((
            StatusCode::PRECONDITION_FAILED,
            Json(
                json!({"error": "2FA verification required (settings changed)", "need_2fa": true}),
            ),
        ));
    }

    // Insert user_id into request extensions for downstream handlers
    request.extensions_mut().insert(user_id);

    Ok(next.run(request).await)
}

/// Extract user_id from JWT token in Authorization header (for public routes that still need auth)
pub fn get_user_id_from_request(auth_header: &str, jwt_secret: &str) -> Result<Uuid, AppError> {
    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(AppError::InvalidToken)?;

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let token_data =
        decode::<JwtClaims>(token, &key, &Validation::new(Algorithm::HS256)).map_err(|e| {
            if matches!(e.kind(), jsonwebtoken::errors::ErrorKind::ExpiredSignature) {
                AppError::TokenExpired
            } else {
                AppError::InvalidToken
            }
        })?;

    let user_id: Uuid = token_data
        .claims
        .sub
        .parse()
        .map_err(|_| AppError::InvalidToken)?;

    Ok(user_id)
}
