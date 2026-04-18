// Ключи
export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export interface EncryptedKeyPair {
    publicKey: Uint8Array;
    encryptedPrivateKey: Uint8Array;
    iv: Uint8Array;
}

// E2E шифрование
export interface EncryptedMessage {
    ciphertext: string;
    nonce: string;
    senderPublicKey?: string;
}

export interface DecryptedMessage {
    content: string;
    verified: boolean;
    senderId?: string;
}

// Crypto конфигурация
export interface CryptoConfig {
    algorithm: 'x25519-xsalsa20-poly1305' | 'aes-gcm';
    keyLength: number;
    nonceLength: number;
}

// Состояние криптографии
export interface CryptoState {
    keyPair: KeyPair | null;
    hasKeys: boolean;
    isInitialized: boolean;
    error: string | null;
}

// Key sync
export interface KeySyncRequest {
    device_name: string;
    user_id: string;
}

export interface KeySyncResponse {
    code: string;
    expires_at: string;
}

export interface KeySyncApproveRequest {
    code: string;
    user_id: string;
}

// Backup encryption
export interface BackupEncryption {
    encryptedPrivateKey: Uint8Array;
    salt: Uint8Array;
    iterations: number;
}

// Хэширование
export interface HashResult {
    hash: string;
    salt: string;
    algorithm: string;
}

// Подписи
export interface Signature {
    signature: string;
    publicKey: string;
    message: string;
}

// Утилиты
export type Base64String = string;
export type HexString = string;