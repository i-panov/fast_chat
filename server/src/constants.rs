//! Application constants — eliminates magic strings throughout the codebase.

/// Redis channel pattern for user events
pub const REDIS_USER_CHANNEL: &str = "user:{user_id}:events";

/// Database settings keys
pub const SETTINGS_KEY_REQUIRE_2FA: &str = "require_2fa";
pub const SETTINGS_KEY_ALLOW_REGISTRATION: &str = "allow_registration";

/// Default values
pub const DEFAULT_JWT_EXPIRY_HOURS: i64 = 24;
pub const DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS: i64 = 7;
pub const DEFAULT_SERVER_ADDR: &str = "0.0.0.0:8080";
pub const DEFAULT_FILES_DIR: &str = "./files";

/// Rate limiting
pub const EMAIL_CODE_EXPIRY_MINUTES: i64 = 10;
pub const TOTP_STEP_SECONDS: u64 = 30;
pub const TOTP_DRIFT_TOLERANCE_SECONDS: u64 = 30;

/// Pagination
pub const DEFAULT_PAGE_SIZE: i32 = 50;
pub const MAX_PAGE_SIZE: i32 = 100;

/// Backup codes
pub const MIN_REMAINING_BACKUP_CODES: usize = 3;
pub const INITIAL_BACKUP_CODES_COUNT: usize = 10;

/// Database table names
pub const TABLE_USERS: &str = "users";
pub const TABLE_CHATS: &str = "chats";
pub const TABLE_CHAT_PARTICIPANTS: &str = "chat_participants";
pub const TABLE_MESSAGES: &str = "messages";
pub const TABLE_CHANNELS: &str = "channels";
pub const TABLE_BOTS: &str = "bots";
pub const TABLE_SERVER_SETTINGS: &str = "server_settings";
pub const TABLE_EMAIL_CODES: &str = "email_codes";
pub const TABLE_USER_SESSIONS: &str = "user_sessions";
