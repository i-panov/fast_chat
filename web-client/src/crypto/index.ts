// fast_chat/web-client/src/crypto/index.ts
// @ts-ignore
import nacl from "tweetnacl";
// @ts-ignore
import naclUtil from "tweetnacl-util";

export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export class CryptoService {
    static generateKeypair(): KeyPair {
        const pair = nacl.box.keyPair();
        return { publicKey: pair.publicKey, secretKey: pair.secretKey };
    }

    static async encryptMessage(
        content: string,
        recipientPublicKey: Uint8Array,
        senderSecretKey: Uint8Array,
    ): Promise<string> {
        const message = naclUtil.decodeUTF8(content);
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(
            message,
            nonce,
            recipientPublicKey,
            senderSecretKey,
        );
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce);
        combined.set(encrypted, nonce.length);
        return naclUtil.encodeBase64(combined);
    }

    static async decryptMessage(
        encryptedContent: string,
        senderPublicKey: Uint8Array,
        recipientSecretKey: Uint8Array,
    ): Promise<string> {
        const combined = naclUtil.decodeBase64(encryptedContent);
        if (combined.length < nacl.box.nonceLength + nacl.box.overheadLength) {
            throw new Error("Invalid encrypted content");
        }
        const nonce = combined.slice(0, nacl.box.nonceLength);
        const ciphertext = combined.slice(nacl.box.nonceLength);
        const decrypted = nacl.box.open(
            ciphertext,
            nonce,
            senderPublicKey,
            recipientSecretKey,
        );
        if (!decrypted) throw new Error("Decryption failed");
        return naclUtil.encodeUTF8(decrypted);
    }

    // Encrypt data with NaCl box (self-encryption: encrypt with own public key)
    static encryptWithKeypair(data: Uint8Array, keyPair: KeyPair): string {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(data, nonce, keyPair.publicKey, keyPair.secretKey);
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce);
        combined.set(encrypted, nonce.length);
        return naclUtil.encodeBase64(combined);
    }

    // Decrypt data with NaCl box (self-decryption: decrypt with own private key)
    static decryptWithKeypair(encryptedData: string, keyPair: KeyPair): Uint8Array {
        const combined = naclUtil.decodeBase64(encryptedData);
        if (combined.length < nacl.box.nonceLength + nacl.box.overheadLength) {
            throw new Error("Invalid encrypted data");
        }
        const nonce = combined.slice(0, nacl.box.nonceLength);
        const ciphertext = combined.slice(nacl.box.nonceLength);
        const decrypted = nacl.box.open(ciphertext, nonce, keyPair.publicKey, keyPair.secretKey);
        if (!decrypted) throw new Error("Decryption failed");
        return decrypted;
    }
}

// Key management in IndexedDB
// Keys are stored encrypted with the keypair itself (self-encryption)
export async function getOrCreateKeypair(): Promise<KeyPair> {
    const db = await import("@/db").then((m) => m.getDb());
    const stored = await db.get("keys", "current");

    if (stored) {
        return {
            publicKey: naclUtil.decodeBase64(stored.publicKey),
            secretKey: naclUtil.decodeBase64(stored.secretKey),
        };
    }

    // Create new keypair
    const newPair = CryptoService.generateKeypair();
    await db.put("keys", {
        publicKey: naclUtil.encodeBase64(newPair.publicKey),
        secretKey: naclUtil.encodeBase64(newPair.secretKey),
    }, "current");

    // Upload public key to server
    try {
        const { api } = await import("@/api/client");
        await api.getMe(); // Ensure we have auth
        await fetch("/api/auth/update-public-key", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ public_key: naclUtil.encodeBase64(newPair.publicKey) }),
        });
    } catch (e) {
        // Silently fail - key will be uploaded on next request
    }

    return newPair;
}

// Get stored keypair for encryption/decryption
export async function getKeypair(): Promise<KeyPair | null> {
    try {
        const db = await import("@/db").then((m) => m.getDb());
        const stored = await db.get("keys", "current");

        if (!stored) return null;

        return {
            publicKey: naclUtil.decodeBase64(stored.publicKey),
            secretKey: naclUtil.decodeBase64(stored.secretKey),
        };
    } catch (e) {
        return null;
    }
}

// ─── Key Sync with Server ───

/**
 * Check if user has encrypted key on server
 */
export async function checkKeyStatus(): Promise<boolean> {
    try {
        const { api } = await import("@/api/client");
        return await api.checkKeyStatus();
    } catch (e) {
        return false;
    }
}

/**
 * Upload encrypted private key to server
 */
export async function uploadEncryptedKey(): Promise<void> {
    const keypair = await getKeypair();
    if (!keypair) throw new Error("No keypair found");

    // Encrypt private key with its own public key (self-encryption)
    const encryptedKey = CryptoService.encryptWithKeypair(keypair.secretKey, keypair);

    const { api } = await import("@/api/client");
    await api.uploadEncryptedKey(encryptedKey);
}

/**
 * Download encrypted private key from server
 */
export async function downloadEncryptedKey(): Promise<Uint8Array> {
    const { api } = await import("@/api/client");
    const encryptedKey = await api.downloadEncryptedKey();
    
    const keypair = await getKeypair();
    if (!keypair) throw new Error("No keypair found");
    
    return CryptoService.decryptWithKeypair(encryptedKey, keypair);
}

/**
 * Restore key from server to local storage
 */
export async function restoreKeyFromServer(): Promise<void> {
    const keypair = await getKeypair();
    if (!keypair) throw new Error("No local keypair");
    
    const decryptedKey = await downloadEncryptedKey();
    
    // Store the restored key (replacing current)
    const db = await import("@/db").then((m) => m.getDb());
    await db.put("keys", {
        publicKey: naclUtil.encodeBase64(keypair.publicKey),
        secretKey: naclUtil.encodeBase64(decryptedKey),
    }, "current");
}

/**
 * Request key sync from new device
 */
export async function requestKeySync(deviceName?: string): Promise<void> {
    const { api } = await import("@/api/client");
    await api.requestKeySync(deviceName);
}

/**
 * Get pending sync requests (for first device)
 */
export async function getPendingSyncs(): Promise<Array<{
    id: string;
    device_name: string;
    created_at: string;
    expires_at: string;
}>> {
    const { api } = await import("@/api/client");
    return await api.getPendingSyncs();
}

/**
 * Approve key sync from first device
 * @param code Confirmation code from new device
 */
export async function approveKeySync(code: string): Promise<void> {
    const keypair = await getKeypair();
    if (!keypair) throw new Error("No keypair found");

    // Encrypt private key with its own public key
    const encryptedKey = CryptoService.encryptWithKeypair(keypair.secretKey, keypair);

    const { api } = await import("@/api/client");
    await api.approveKeySync(code, encryptedKey);
}

/**
 * Initialize keys on login:
 * 1. Check if server has encrypted key
 * 2. If yes and we don't have local key - download and restore
 * 3. If no - upload our key
 */
export async function initializeKeys(): Promise<void> {
    const keypair = await getKeypair();

    if (!keypair) {
        // No local key - create new one
        await getOrCreateKeypair();
    }

    try {
        // Check server status
        const hasServerKey = await checkKeyStatus();

        if (!hasServerKey) {
            // No key on server - upload ours
            await uploadEncryptedKey();
        }
        // If server has key and we have local key - we're good
    } catch (e) {
        // If anything fails, just log - don't block login
        console.warn("Key initialization failed:", e);
    }
}