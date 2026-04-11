use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Clone)]
pub struct Settings {
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub jwt_expiry_hours: i64,
    pub refresh_token_expiry_days: i64,
    pub files_dir: PathBuf,
    pub server_addr: String,
    pub coturn_host: String,
    pub coturn_port: u16,
    pub ion_sfu_url: Option<String>,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub allow_registration: bool,
    pub require_2fa: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            database_url: "postgres://fast_chat:changeme@localhost:5432/fast_chat".to_string(),
            redis_url: "redis://localhost:6379".to_string(),
            jwt_secret: "changeme".to_string(),
            jwt_expiry_hours: 24,
            refresh_token_expiry_days: 7,
            files_dir: PathBuf::from("./files"),
            server_addr: "0.0.0.0:8080".to_string(),
            coturn_host: "localhost".to_string(),
            coturn_port: 3478,
            ion_sfu_url: None,
            tls_cert_path: None,
            tls_key_path: None,
            allow_registration: false,
            require_2fa: false,
        }
    }
}
