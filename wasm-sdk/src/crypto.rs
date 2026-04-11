use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use rand::RngCore;
use wasm_bindgen::prelude::*;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

/// Represents a user's cryptographic keys for E2E encryption
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct KeyPair {
    pub public_key: String,
    /// Private key - MUST be stored securely (IndexedDB with encryption)
    pub private_key: String,
}

/// Result of encryption operation
#[derive(serde::Serialize, serde::Deserialize)]
pub struct EncryptedMessage {
    /// Base64-encoded: ephemeral_public_key(32 bytes) + ciphertext
    pub encrypted_content: String,
    /// Base64-encoded nonce (12 bytes)
    pub nonce: String,
}

/// E2E crypto service for WASM
#[wasm_bindgen]
pub struct CryptoService;

#[wasm_bindgen]
impl CryptoService {
    /// Initialize WASM console error panic hook (call once on startup)
    #[wasm_bindgen(js_name = initPanicHook)]
    pub fn init_panic_hook() {
        console_error_panic_hook::set_once();
    }

    /// Generate a new X25519 keypair for E2E encryption
    /// Returns JSON: { public_key: string, private_key: string } (base64-encoded)
    #[wasm_bindgen(js_name = generateKeypair)]
    pub fn generate_keypair() -> Result<String, JsError> {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);

        let keypair = KeyPair {
            public_key: BASE64.encode(public.as_bytes()),
            private_key: BASE64.encode(secret.as_bytes()),
        };

        serde_json::to_string(&keypair).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Encrypt a message using the recipient's public key
    /// 
    /// # Arguments
    /// * `content` - plaintext message content
    /// * `recipient_public_key` - base64-encoded X25519 public key
    /// 
    /// Returns JSON: { encrypted_content: string, nonce: string }
    #[wasm_bindgen(js_name = encryptMessage)]
    pub fn encrypt_message(content: &str, recipient_public_key: &str) -> Result<String, JsError> {
        let public_key_bytes = BASE64
            .decode(recipient_public_key)
            .map_err(|_| JsError::new("Invalid public key"))?;

        if public_key_bytes.len() != 32 {
            return Err(JsError::new("Invalid public key length"));
        }

        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&public_key_bytes);
        let recipient_public = PublicKey::from(key_bytes);

        // Ephemeral key exchange
        let ephemeral_secret = EphemeralSecret::random_from_rng(OsRng);
        let ephemeral_public = PublicKey::from(&ephemeral_secret);

        // Derive shared secret
        let shared_secret = ephemeral_secret.diffie_hellman(&recipient_public);
        let key = shared_secret.as_bytes();

        // Encrypt with ChaCha20Poly1305
        let cipher = ChaCha20Poly1305::new(key.into());
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, content.as_bytes())
            .map_err(|_| JsError::new("Encryption failed"))?;

        // Combine ephemeral public key + ciphertext
        let mut result = ephemeral_public.as_bytes().to_vec();
        result.extend(ciphertext);

        let encrypted_message = EncryptedMessage {
            encrypted_content: BASE64.encode(&result),
            nonce: BASE64.encode(nonce_bytes),
        };

        serde_json::to_string(&encrypted_message).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Decrypt a message using the recipient's private key
    /// 
    /// # Arguments
    /// * `encrypted_content` - base64-encoded ephemeral_public_key + ciphertext
    /// * `nonce` - base64-encoded nonce (12 bytes)
    /// * `private_key` - base64-encoded X25519 private key
    /// 
    /// Returns decrypted plaintext string
    #[wasm_bindgen(js_name = decryptMessage)]
    pub fn decrypt_message(
        encrypted_content: &str,
        nonce: &str,
        private_key: &str,
    ) -> Result<String, JsError> {
        let private_key_bytes = BASE64
            .decode(private_key)
            .map_err(|_| JsError::new("Invalid private key"))?;

        if private_key_bytes.len() != 32 {
            return Err(JsError::new("Invalid private key length"));
        }

        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&private_key_bytes);
        let private = StaticSecret::from(key_bytes);

        let data = BASE64
            .decode(encrypted_content)
            .map_err(|_| JsError::new("Invalid ciphertext"))?;

        if data.len() < 32 {
            return Err(JsError::new("Invalid ciphertext length"));
        }

        let mut ephemeral_bytes = [0u8; 32];
        ephemeral_bytes.copy_from_slice(&data[..32]);
        let ephemeral_public = PublicKey::from(ephemeral_bytes);

        let shared_secret = private.diffie_hellman(&ephemeral_public);
        let key = shared_secret.as_bytes();

        let nonce_bytes = BASE64
            .decode(nonce)
            .map_err(|_| JsError::new("Invalid nonce"))?;

        if nonce_bytes.len() != 12 {
            return Err(JsError::new("Invalid nonce length"));
        }

        let cipher = ChaCha20Poly1305::new(key.into());
        let nonce_ref = Nonce::from_slice(&nonce_bytes);
        let ciphertext = &data[32..];

        let plaintext = cipher
            .decrypt(nonce_ref, ciphertext)
            .map_err(|_| JsError::new("Decryption failed"))?;

        String::from_utf8(plaintext).map_err(|_| JsError::new("Invalid UTF-8 in decrypted message"))
    }

    /// Derive a shared secret for a chat (from your private key + peer's public key)
    /// Returns base64-encoded 32-byte shared secret
    #[wasm_bindgen(js_name = deriveSharedSecret)]
    pub fn derive_shared_secret(
        my_private_key: &str,
        peer_public_key: &str,
    ) -> Result<String, JsError> {
        let private_key_bytes = BASE64
            .decode(my_private_key)
            .map_err(|_| JsError::new("Invalid private key"))?;

        let public_key_bytes = BASE64
            .decode(peer_public_key)
            .map_err(|_| JsError::new("Invalid public key"))?;

        if private_key_bytes.len() != 32 || public_key_bytes.len() != 32 {
            return Err(JsError::new("Invalid key length"));
        }

        let mut priv_bytes = [0u8; 32];
        priv_bytes.copy_from_slice(&private_key_bytes);
        let mut pub_bytes = [0u8; 32];
        pub_bytes.copy_from_slice(&public_key_bytes);

        let private = StaticSecret::from(priv_bytes);
        let public = PublicKey::from(pub_bytes);

        let shared_secret = private.diffie_hellman(&public);
        Ok(BASE64.encode(shared_secret.as_bytes()))
    }

    /// Generate a random hex string (for CSRF tokens, etc.)
    #[wasm_bindgen(js_name = generateRandomHex)]
    pub fn generate_random_hex(bytes: usize) -> String {
        let mut buf = vec![0u8; bytes];
        OsRng.fill_bytes(&mut buf);
        buf.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
