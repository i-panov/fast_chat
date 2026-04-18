export interface KeySyncRequest {
    id: string;
    device_name: string;
    created_at: string;
    expires_at: string;
}

export interface KeySyncApproveRequest {
    code: string;
    encrypted_private_key: string;
}

export interface KeyStatusResponse {
    has_encrypted_key: boolean;
}

export interface EncryptedKeyResponse {
    encrypted_private_key: string;
}

export interface CryptoState {
    publicKey: string | null;
    secretKey: string | null;
    encryptedPrivateKey: string | null;
    keySyncRequests: KeySyncRequest[];
}