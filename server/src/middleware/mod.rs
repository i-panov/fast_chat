use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use tonic::Status;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: i64,
    iat: i64,
}

// Status is a tonic standard type — boxing it is impractical and non-idiomatic
#[allow(clippy::result_large_err)]
pub fn get_user_id_from_request<T>(
    request: &tonic::Request<T>,
    jwt_secret: &str,
) -> Result<Uuid, Status> {
    get_user_id_from_metadata(request.metadata(), jwt_secret)
}

#[allow(clippy::result_large_err)]
pub fn get_user_id_from_metadata(
    metadata: &tonic::metadata::MetadataMap,
    jwt_secret: &str,
) -> Result<Uuid, Status> {
    let token = metadata
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Status::unauthenticated("Missing authorization header"))?;

    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let token_data = decode::<Claims>(token, &key, &Validation::new(Algorithm::HS256))
        .map_err(|_| Status::unauthenticated("Invalid token"))?;

    let user_id: Uuid = token_data
        .claims
        .sub
        .parse()
        .map_err(|_| Status::unauthenticated("Invalid user ID in token"))?;

    Ok(user_id)
}

pub async fn check_chat_participation(
    pool: &sqlx::PgPool,
    chat_id: Uuid,
    user_id: Uuid,
) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2)"
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

#[allow(dead_code)]
#[allow(clippy::result_large_err)]
pub fn get_user_id_from_token(token: &str, jwt_secret: &str) -> Result<Uuid, Status> {
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let token_data = decode::<Claims>(token, &key, &Validation::new(Algorithm::HS256))
        .map_err(|_| Status::unauthenticated("Invalid token"))?;

    let user_id: Uuid = token_data
        .claims
        .sub
        .parse()
        .map_err(|_| Status::unauthenticated("Invalid user ID in token"))?;

    Ok(user_id)
}

#[allow(dead_code)]
pub fn generate_access_token(
    user_id: Uuid,
    jwt_secret: &str,
    expiry_hours: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    use chrono::Utc;

    let now = Utc::now();
    let expiry = now + chrono::Duration::hours(expiry_hours);

    let claims = Claims {
        sub: user_id.to_string(),
        exp: expiry.timestamp(),
        iat: now.timestamp(),
    };

    let key = EncodingKey::from_secret(jwt_secret.as_bytes());
    encode(&Header::new(Algorithm::HS256), &claims, &key)
}
