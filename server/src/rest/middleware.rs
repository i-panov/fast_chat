use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
use uuid::Uuid;
use crate::AppState;

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let user_id = validate_token(auth_header, &state.settings.jwt_secret)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Check if user is admin
    let is_admin: Option<bool> = sqlx::query_scalar("SELECT is_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(state.db.get_pool())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if !is_admin.unwrap_or(false) {
        return Err(StatusCode::FORBIDDEN);
    }

    // Store user_id in request extensions for handlers
    req.extensions_mut().insert(user_id);

    Ok(next.run(req).await)
}

fn validate_token(token: &str, jwt_secret: &str) -> Result<Uuid, String> {
    use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
    use chrono::Utc;

    #[derive(serde::Deserialize)]
    struct Claims {
        sub: String,
        exp: i64,
    }

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = false; // manual check

    let token_data = decode::<Claims>(token, &key, &validation)
        .map_err(|e| format!("Invalid token: {}", e))?;

    // Check expiry
    if token_data.claims.exp < Utc::now().timestamp() {
        return Err("Token expired".to_string());
    }

    let user_id: Uuid = token_data
        .claims
        .sub
        .parse()
        .map_err(|_| "Invalid user ID".to_string())?;

    Ok(user_id)
}
