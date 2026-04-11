use futures::StreamExt;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::middleware::get_user_id_from_request;
use crate::models::File;
use crate::proto::common::FileMetadata as ProtoFileMetadata;
use crate::proto::files::{DataChunk, DownloadRequest, FileRequest, UploadRequest, UploadResponse};
use crate::{error::AppError, AppState};

/// Maximum allowed file size: 100 MB
const MAX_FILE_SIZE: i64 = 100 * 1024 * 1024;

/// Allowed MIME types — basic validation to prevent malicious uploads
const ALLOWED_MIME_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/pdf",
    "text/plain",
    "application/zip",
    "application/x-tar",
    "application/gzip",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "application/octet-stream",
];

pub struct FilesService {
    state: Arc<AppState>,
}

impl FilesService {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn file_to_proto(&self, file: &File) -> ProtoFileMetadata {
        ProtoFileMetadata {
            id: file.id.to_string(),
            original_name: file.original_name.clone(),
            mime_type: file.mime_type.clone().unwrap_or_default(),
            size_bytes: file.size_bytes,
            uploader_id: file.uploader_id.to_string(),
            uploaded_at: file.uploaded_at.to_rfc3339(),
        }
    }
}

#[tonic::async_trait]
impl crate::proto::files::files_server::Files for FilesService {
    async fn upload(
        &self,
        request: Request<tonic::Streaming<UploadRequest>>,
    ) -> Result<Response<UploadResponse>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;
        
        let mut stream = request.into_inner();
        let state = self.state.clone();

        let mut metadata: Option<(String, String)> = None;
        let file_id = Uuid::new_v4();
        let stored_path = state.settings.files_dir.join(file_id.to_string());
        let mut total_size: i64 = 0;

        let mut file = tokio::fs::File::create(&stored_path)
            .await
            .map_err(AppError::Io)?;

        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(UploadRequest {
                    data: Some(crate::proto::files::upload_request::Data::Metadata(meta)),
                }) => {
                    metadata = Some((meta.filename, meta.mime_type));
                }
                Ok(UploadRequest {
                    data: Some(crate::proto::files::upload_request::Data::Chunk(chunk_data)),
                }) => {
                    total_size += chunk_data.len() as i64;
                    if total_size > MAX_FILE_SIZE {
                        // Clean up the partial file
                        drop(file);
                        let _ = tokio::fs::remove_file(&stored_path).await;
                        return Err(Status::invalid_argument(format!(
                            "File size exceeds maximum allowed size of {} MB",
                            MAX_FILE_SIZE / 1024 / 1024
                        )));
                    }
                    file.write_all(&chunk_data)
                        .await
                        .map_err(AppError::Io)?;
                }
                Err(e) => {
                    tracing::error!("Upload stream error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        file.flush().await.map_err(AppError::Io)?;
        drop(file);

        let (original_name, mime_type) = metadata.unwrap_or((
            "unknown".to_string(),
            "application/octet-stream".to_string(),
        ));

        // Validate MIME type
        if !ALLOWED_MIME_TYPES.contains(&mime_type.as_str()) {
            // Clean up the file
            let _ = tokio::fs::remove_file(&stored_path).await;
            return Err(Status::invalid_argument(format!(
                "MIME type '{}' is not allowed",
                mime_type
            )));
        }

        sqlx::query(
            r#"
            INSERT INTO files (id, original_name, stored_path, mime_type, size_bytes, uploader_id, uploaded_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            "#
        )
        .bind(file_id)
        .bind(&original_name)
        .bind(stored_path.to_string_lossy().to_string())
        .bind(&mime_type)
        .bind(total_size)
        .bind(user_id)
        .execute(state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        Ok(Response::new(UploadResponse {
            metadata: Some(ProtoFileMetadata {
                id: file_id.to_string(),
                original_name,
                mime_type,
                size_bytes: total_size,
                uploader_id: user_id.to_string(),
                uploaded_at: chrono::Utc::now().to_rfc3339(),
            }),
        }))
    }

    type DownloadStream = tokio_stream::wrappers::ReceiverStream<Result<DataChunk, Status>>;

    async fn download(
        &self,
        request: Request<DownloadRequest>,
    ) -> Result<Response<Self::DownloadStream>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let file_id: Uuid = req.file_id.parse().map_err(|_| AppError::FileNotFound)?;

        let file = sqlx::query_as::<_, File>("SELECT * FROM files WHERE id = $1")
            .bind(file_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::FileNotFound)?;

        // Verify the user is a participant in a chat that contains this file
        // Files are linked to chats via messages.file_metadata_id
        let is_participant = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM messages m
                JOIN chat_participants cp ON cp.chat_id = m.chat_id
                WHERE m.file_metadata_id = $1 AND cp.user_id = $2
            )
            "#
        )
        .bind(file_id)
        .bind(user_id)
        .fetch_one(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        // Also allow the uploader to download (they may not be in a chat yet if upload failed mid-way)
        let is_uploader = file.uploader_id == user_id;

        if !is_participant && !is_uploader {
            return Err(Status::permission_denied("You do not have access to this file"));
        }

        let stored_path = std::path::Path::new(&file.stored_path);
        let total_size = file.size_bytes;
        let chunk_size = 64 * 1024; // 64 KB chunks

        let (tx, rx) = tokio::sync::mpsc::channel(100);
        let path = stored_path.to_path_buf();

        tokio::spawn(async move {
            let mut file_handle = match tokio::fs::File::open(&path).await {
                Ok(f) => f,
                Err(e) => {
                    let _ = tx.send(Err(Status::not_found(format!("File not found: {}", e)))).await;
                    return;
                }
            };

            let mut buffer = vec![0u8; chunk_size];
            let mut offset: i64 = 0;

            loop {
                match tokio::io::AsyncReadExt::read(&mut file_handle, &mut buffer).await {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = DataChunk {
                            data: buffer[..n].to_vec(),
                            offset,
                            total_size,
                        };
                        if tx.send(Ok(chunk)).await.is_err() {
                            break; // Receiver dropped
                        }
                        offset += n as i64;
                    }
                    Err(e) => {
                        let _ = tx.send(Err(Status::internal(format!("Read error: {}", e)))).await;
                        break;
                    }
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    async fn get_metadata(
        &self,
        request: Request<FileRequest>,
    ) -> Result<Response<ProtoFileMetadata>, Status> {
        let user_id = get_user_id_from_request(&request, &self.state.settings.jwt_secret)
            .map_err(|_| AppError::InvalidToken)?;

        let req = request.into_inner();
        let file_id: Uuid = req.file_id.parse().map_err(|_| AppError::FileNotFound)?;

        let file = sqlx::query_as::<_, File>("SELECT * FROM files WHERE id = $1")
            .bind(file_id)
            .fetch_optional(self.state.db.get_pool())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::FileNotFound)?;

        // Same access control as download
        let is_participant = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM messages m
                JOIN chat_participants cp ON cp.chat_id = m.chat_id
                WHERE m.file_metadata_id = $1 AND cp.user_id = $2
            )
            "#
        )
        .bind(file_id)
        .bind(user_id)
        .fetch_one(self.state.db.get_pool())
        .await
        .map_err(AppError::from)?;

        let is_uploader = file.uploader_id == user_id;

        if !is_participant && !is_uploader {
            return Err(Status::permission_denied("You do not have access to this file"));
        }

        Ok(Response::new(self.file_to_proto(&file)))
    }
}
