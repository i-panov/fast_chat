use aes_gcm::{Aes256Gcm, Nonce as AesNonce};
use argon2::{password_hash::SaltString, Argon2, PasswordHasher, PasswordVerifier};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

#[allow(dead_code)]
pub struct CryptoService;

#[allow(dead_code)]
impl CryptoService {
    pub fn generate_keypair() -> (String, String) {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);

        (
            BASE64.encode(secret.as_bytes()),
            BASE64.encode(public.as_bytes()),
        )
    }

    pub fn encrypt_message(
        content: &[u8],
        recipient_public_key: &str,
    ) -> Result<Vec<u8>, CryptoError> {
        let public_key_bytes = BASE64
            .decode(recipient_public_key)
            .map_err(|_| CryptoError::InvalidPublicKey)?;

        let mut key_bytes = [0u8; 32];
        if public_key_bytes.len() != 32 {
            return Err(CryptoError::InvalidPublicKey);
        }
        key_bytes.copy_from_slice(&public_key_bytes);
        let recipient_public = PublicKey::from(key_bytes);

        let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
        let ephemeral_public = PublicKey::from(&ephemeral_secret);

        let shared_secret = ephemeral_secret.diffie_hellman(&recipient_public);
        let key = shared_secret.as_bytes();

        let cipher = ChaCha20Poly1305::new(key.into());
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, content)
            .map_err(|_| CryptoError::EncryptionFailed)?;

        let mut result = ephemeral_public.as_bytes().to_vec();
        result.extend(&nonce_bytes);
        result.extend(ciphertext);

        Ok(result)
    }

    pub fn decrypt_message(encrypted: &[u8], private_key: &str) -> Result<Vec<u8>, CryptoError> {
        // Format: ephemeral_public (32 bytes) + nonce (12 bytes) + ciphertext
        if encrypted.len() < 44 {
            return Err(CryptoError::InvalidCiphertext);
        }

        let private_key_bytes = BASE64
            .decode(private_key)
            .map_err(|_| CryptoError::InvalidPrivateKey)?;

        let mut key_bytes = [0u8; 32];
        if private_key_bytes.len() != 32 {
            return Err(CryptoError::InvalidPrivateKey);
        }
        key_bytes.copy_from_slice(&private_key_bytes);
        let private = StaticSecret::from(key_bytes);

        let mut ephemeral_bytes = [0u8; 32];
        ephemeral_bytes.copy_from_slice(&encrypted[..32]);
        let ephemeral_public = PublicKey::from(ephemeral_bytes);

        let shared_secret = private.diffie_hellman(&ephemeral_public);
        let key = shared_secret.as_bytes();

        let cipher = ChaCha20Poly1305::new(key.into());
        let nonce = Nonce::from_slice(&encrypted[32..44]);
        let ciphertext = &encrypted[44..];

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| CryptoError::DecryptionFailed)
    }

    pub fn hash_password(password: &str) -> Result<String, CryptoError> {
        let salt = SaltString::generate(&mut OsRng);
        let argon2 = Argon2::default();

        let hash = argon2
            .hash_password(password.as_bytes(), &salt)
            .map_err(|_| CryptoError::PasswordHashFailed)?;

        Ok(hash.to_string())
    }

    pub fn verify_password(password: &str, hash: &str) -> Result<bool, CryptoError> {
        let parsed_hash =
            argon2::PasswordHash::new(hash).map_err(|_| CryptoError::PasswordHashFailed)?;

        Ok(argon2::Argon2::default()
            .verify_password(password.as_bytes(), &parsed_hash)
            .is_ok())
    }

    pub fn generate_backup_codes(count: usize) -> Vec<String> {
        let mut codes = Vec::with_capacity(count);
        for _ in 0..count {
            let code: String = (0..8)
                .map(|_| {
                    let idx = (OsRng.next_u32() % 36) as u8;
                    if idx < 10 {
                        (b'0' + idx) as char
                    } else {
                        (b'A' + idx - 10) as char
                    }
                })
                .collect();
            codes.push(code);
        }
        codes
    }

    /// Hash individual backup codes — each code is hashed separately with argon2
    /// Returns a JSON array of argon2 hashes, one per code
    pub fn hash_backup_codes(codes: &[String]) -> Result<String, CryptoError> {
        let argon2 = Argon2::default();
        let hashes: Vec<String> = codes
            .iter()
            .map(|code| {
                let salt = SaltString::generate(&mut OsRng);
                let hash = argon2
                    .hash_password(code.as_bytes(), &salt)
                    .map_err(|_| CryptoError::PasswordHashFailed)?;
                Ok(hash.to_string())
            })
            .collect::<Result<Vec<_>, CryptoError>>()?;

        serde_json::to_string(&hashes).map_err(|_| CryptoError::PasswordHashFailed)
    }

    /// Verify a single backup code against the array of argon2 hashes
    pub fn verify_backup_code(code: &str, hashes_json: &str) -> Result<bool, CryptoError> {
        let hashes: Vec<String> =
            serde_json::from_str(hashes_json).map_err(|_| CryptoError::PasswordHashFailed)?;

        let argon2 = argon2::Argon2::default();

        for hash_str in &hashes {
            let parsed_hash =
                argon2::PasswordHash::new(hash_str).map_err(|_| CryptoError::PasswordHashFailed)?;
            if argon2
                .verify_password(code.as_bytes(), &parsed_hash)
                .is_ok()
            {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Find the index of a matching backup code (for removal)
    pub fn find_backup_code_index(codes: &[String], target: &str) -> Option<usize> {
        codes.iter().position(|c| c == target)
    }

    /// Legacy: verify codes joined with '|' against a single argon2 hash
    #[allow(dead_code)]
    pub fn verify_backup_codes_legacy(
        codes: &[String],
        stored_hash: &str,
    ) -> Result<bool, CryptoError> {
        let combined: String = codes.join("|");
        let parsed_hash =
            argon2::PasswordHash::new(stored_hash).map_err(|_| CryptoError::PasswordHashFailed)?;

        Ok(argon2::Argon2::default()
            .verify_password(combined.as_bytes(), &parsed_hash)
            .is_ok())
    }

    /// Derive a 32-byte AES key from a secret string using SHA-256
    fn derive_aes_key(secret: &str) -> [u8; 32] {
        let mut key = [0u8; 32];
        key.copy_from_slice(&Sha256::digest(secret.as_bytes()));
        key
    }

    /// Encrypt data using AES-GCM, returns base64(nonce + ciphertext)
    pub fn encrypt_aes(data: &[u8], secret: &str) -> Result<String, CryptoError> {
        let key = Self::derive_aes_key(secret);
        let cipher = Aes256Gcm::new(&key.into());
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = AesNonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, data)
            .map_err(|_| CryptoError::EncryptionFailed)?;

        let mut result = nonce_bytes.to_vec();
        result.extend(ciphertext);
        Ok(BASE64.encode(result))
    }

    /// Decrypt data from base64(nonce + ciphertext) using AES-GCM
    pub fn decrypt_aes(encoded: &str, secret: &str) -> Result<Vec<u8>, CryptoError> {
        let key = Self::derive_aes_key(secret);
        let cipher = Aes256Gcm::new(&key.into());
        let data = BASE64
            .decode(encoded)
            .map_err(|_| CryptoError::DecryptionFailed)?;

        if data.len() < 13 {
            return Err(CryptoError::DecryptionFailed);
        }

        let nonce = AesNonce::from_slice(&data[..12]);
        let ciphertext = &data[12..];

        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| CryptoError::DecryptionFailed)
    }

    /// Encrypt a TOTP secret using AES-GCM, returns base64(nonce + ciphertext)
    pub fn encrypt_totp_secret(secret: &str, encryption_key: &str) -> Result<String, CryptoError> {
        Self::encrypt_aes(secret.as_bytes(), encryption_key)
    }

    /// Decrypt a TOTP secret from base64(nonce + ciphertext) using AES-GCM
    pub fn decrypt_totp_secret(encoded: &str, encryption_key: &str) -> Result<String, CryptoError> {
        let decrypted = Self::decrypt_aes(encoded, encryption_key)?;
        String::from_utf8(decrypted).map_err(|_| CryptoError::DecryptionFailed)
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum CryptoError {
    InvalidPublicKey,
    InvalidPrivateKey,
    InvalidCiphertext,
    EncryptionFailed,
    DecryptionFailed,
    PasswordHashFailed,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::InvalidPublicKey => write!(f, "Invalid public key"),
            CryptoError::InvalidPrivateKey => write!(f, "Invalid private key"),
            CryptoError::InvalidCiphertext => write!(f, "Invalid ciphertext"),
            CryptoError::EncryptionFailed => write!(f, "Encryption failed"),
            CryptoError::DecryptionFailed => write!(f, "Decryption failed"),
            CryptoError::PasswordHashFailed => write!(f, "Password hashing failed"),
        }
    }
}

impl std::error::Error for CryptoError {}
