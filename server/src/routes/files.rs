use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header::AUTHORIZATION, HeaderMap},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use tokio::fs::File as TokioFile;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    error::AppError, middleware::jwt::get_user_id_from_request, models::File as DbFile,
    routes::dto::FileResponse, AppState,
};

pub async fn get_user_id(headers: &HeaderMap, state: &AppState) -> Result<Uuid, AppError> {
    let auth_header = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::InvalidToken)?;
    get_user_id_from_request(auth_header, &state.settings.jwt_secret)
}

pub async fn upload_file(
    State(state): State<std::sync::Arc<AppState>>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<FileResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;

    let mut files = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?
    {
        let file_name = field.file_name().unwrap_or("unknown").to_string();
        let content_type = field.content_type().map(|s| s.to_string());
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::Validation(e.to_string()))?;

        let size_bytes = data.len() as i64;
        let id = Uuid::new_v4();
        let stored_path = format!(
            "{}.{}",
            id,
            file_name.split('.').next_back().unwrap_or("bin")
        );
        let full_path = state.settings.files_dir.join(&stored_path);

        tokio::fs::write(&full_path, &data).await?;

        let now = Utc::now();
        let file = sqlx::query_as::<_, DbFile>(
            "INSERT INTO files (id, original_name, stored_path, mime_type, size_bytes, uploader_id, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        )
        .bind(id)
        .bind(&file_name)
        .bind(&stored_path)
        .bind(content_type)
        .bind(size_bytes)
        .bind(user_id)
        .bind(now)
        .fetch_one(state.db.get_pool())
        .await?;

        files.push(FileResponse::from(&file));
    }

    // Return the first file if multiple uploaded
    Ok(Json(files.into_iter().next().ok_or(
        AppError::Validation("No files in request".to_string()),
    )?))
}

pub async fn upload_file_for_chat(
    State(state): State<std::sync::Arc<AppState>>,
    Path(chat_id): Path<String>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<FileResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let chat_id: Uuid = chat_id.parse().map_err(|_| AppError::ChatNotFound)?;

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_participants WHERE chat_id = $1 AND user_id = $2)",
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_one(state.db.get_pool())
    .await?;

    if !exists {
        return Err(AppError::NotAuthorized);
    }

    let mut files = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?
    {
        let file_name = field.file_name().unwrap_or("unknown").to_string();
        let content_type = field.content_type().map(|s| s.to_string());
        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::Validation(e.to_string()))?;

        let size_bytes = data.len() as i64;
        let id = Uuid::new_v4();
        let stored_path = format!(
            "{}.{}",
            id,
            file_name.split('.').next_back().unwrap_or("bin")
        );
        let full_path = state.settings.files_dir.join(&stored_path);

        tokio::fs::write(&full_path, &data).await?;

        let now = Utc::now();
        let file = sqlx::query_as::<_, DbFile>(
            "INSERT INTO files (id, original_name, stored_path, mime_type, size_bytes, uploader_id, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        )
        .bind(id)
        .bind(&file_name)
        .bind(&stored_path)
        .bind(content_type)
        .bind(size_bytes)
        .bind(user_id)
        .bind(now)
        .fetch_one(state.db.get_pool())
        .await?;

        files.push(FileResponse::from(&file));
    }

    Ok(Json(files.into_iter().next().ok_or(
        AppError::Validation("No files in request".to_string()),
    )?))
}

pub async fn download_file(
    State(state): State<std::sync::Arc<AppState>>,
    Path(file_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let file_id: Uuid = file_id.parse().map_err(|_| AppError::FileNotFound)?;

    let file = sqlx::query_as::<_, DbFile>("SELECT * FROM files WHERE id = $1")
        .bind(file_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::FileNotFound)?;

    // Check if user is uploader or participant in any chat with this file
    if file.uploader_id != user_id {
        let is_participant: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM messages m
                JOIN chat_participants cp ON m.chat_id = cp.chat_id
                WHERE m.file_metadata_id = $1 AND cp.user_id = $2
            )
            "#,
        )
        .bind(file_id)
        .bind(user_id)
        .fetch_one(state.db.get_pool())
        .await?;

        if !is_participant {
            return Err(AppError::NotAuthorized);
        }
    }

    let full_path = state.settings.files_dir.join(&file.stored_path);

    let file_handle = TokioFile::open(&full_path).await?;
    let stream = ReaderStream::new(file_handle);

    let body = Body::from_stream(stream);

    let headers = [
        (
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", file.original_name),
        ),
        ("Content-Length", file.size_bytes.to_string()),
    ];

    Ok((headers, body))
}

pub async fn get_file_meta(
    State(state): State<std::sync::Arc<AppState>>,
    Path(file_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Json<FileResponse>, AppError> {
    let user_id = get_user_id(&headers, &state).await?;
    let file_id: Uuid = file_id.parse().map_err(|_| AppError::FileNotFound)?;

    let file = sqlx::query_as::<_, DbFile>("SELECT * FROM files WHERE id = $1")
        .bind(file_id)
        .fetch_optional(state.db.get_pool())
        .await?
        .ok_or(AppError::FileNotFound)?;

    // Check access
    if file.uploader_id != user_id {
        let is_participant: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM messages m
                JOIN chat_participants cp ON m.chat_id = cp.chat_id
                WHERE m.file_metadata_id = $1 AND cp.user_id = $2
            )
            "#,
        )
        .bind(file_id)
        .bind(user_id)
        .fetch_one(state.db.get_pool())
        .await?;

        if !is_participant {
            return Err(AppError::NotAuthorized);
        }
    }

    Ok(Json(FileResponse::from(&file)))
}
