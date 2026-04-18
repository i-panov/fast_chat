import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { argon2id } from '@noble/hashes/argon2';
import { randomBytes } from '@noble/hashes/utils';
import type { KeyPair, BackupEncryption } from '../types';

export class CryptoService {

    // ─── Key Generation ───
    generateKeyPair(): KeyPair {
        const pair = nacl.box.keyPair();
        return {
            publicKey: pair.publicKey,
            secretKey: pair.secretKey,
        };
    }

    // ─── E2E Encryption ───
    async encryptMessage(
        content: string,
        recipientPublicKey: Uint8Array,
        senderSecretKey: Uint8Array
    ): Promise<string> {
        const message = naclUtil.decodeUTF8(content);
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        
        const encrypted = nacl.box(
            message,
            nonce,
            recipientPublicKey,
            senderSecretKey
        );
        
        if (!encrypted) {
            throw new Error('Encryption failed');
        }
        
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce);
        combined.set(encrypted, nonce.length);
        
        return naclUtil.encodeBase64(combined);
    }

    async decryptMessage(
        encryptedContent: string,
        senderPublicKey: Uint8Array,
        recipientSecretKey: Uint8Array
    ): Promise<string> {
        const combined = naclUtil.decodeBase64(encryptedContent);
        
        if (combined.length < nacl.box.nonceLength + nacl.box.overheadLength) {
            throw new Error('Invalid encrypted content');
        }
        
        const nonce = combined.slice(0, nacl.box.nonceLength);
        const ciphertext = combined.slice(nacl.box.nonceLength);
        
        const decrypted = nacl.box.open(
            ciphertext,
            nonce,
            senderPublicKey,
            recipientSecretKey
        );
        
        if (!decrypted) {
            throw new Error('Decryption failed');
        }
        
        return naclUtil.encodeUTF8(decrypted);
    }

    // ─── Self-Encryption (for local storage) ───
    encryptWithKeypair(data: Uint8Array, keyPair: KeyPair): string {
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        
        const encrypted = nacl.box(
            data,
            nonce,
            keyPair.publicKey,
            keyPair.secretKey
        );
        
        if (!encrypted) {
            throw new Error('Self-encryption failed');
        }
        
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce);
        combined.set(encrypted, nonce.length);
        
        return naclUtil.encodeBase64(combined);
    }

    decryptWithKeypair(encryptedData: string, keyPair: KeyPair): Uint8Array {
        const combined = naclUtil.decodeBase64(encryptedData);
        
        if (combined.length < nacl.box.nonceLength + nacl.box.overheadLength) {
            throw new Error('Invalid encrypted data');
        }
        
        const nonce = combined.slice(0, nacl.box.nonceLength);
        const ciphertext = combined.slice(nacl.box.nonceLength);
        
        const decrypted = nacl.box.open(
            ciphertext,
            nonce,
            keyPair.publicKey,
            keyPair.secretKey
        );
        
        if (!decrypted) {
            throw new Error('Self-decryption failed');
        }
        
        return decrypted;
    }

    // ─── Backup Encryption (with password) ───
    async encryptPrivateKey(
        privateKey: Uint8Array,
        password: string
    ): Promise<BackupEncryption> {
        // Генерируем соль
        const salt = randomBytes(16);
        
        // Деривируем ключ из пароля
        const keyMaterial = await this.deriveKeyFromPassword(password, salt);
        
        // Генерируем IV для AES-GCM
        const iv = randomBytes(12);
        
        // Используем Web Crypto API для AES-GCM шифрования
        const keyMaterialArray = new Uint8Array(keyMaterial);
        const ivArray = new Uint8Array(iv);
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyMaterialArray.buffer,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );
        
        const encrypted = await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: ivArray.buffer,
                tagLength: 128,
            },
            cryptoKey,
            new Uint8Array(privateKey).buffer
        );
        
        return {
            encryptedPrivateKey: new Uint8Array(encrypted),
            salt,
            iterations: 100000,
        };
    }

    async decryptPrivateKey(
        encryptedData: BackupEncryption,
        password: string
    ): Promise<Uint8Array> {
        const { encryptedPrivateKey, salt } = encryptedData;
        
        // Деривируем ключ из пароля
        const keyMaterial = await this.deriveKeyFromPassword(password, salt);
        
        // Извлекаем IV (первые 12 байт)
        const iv = encryptedPrivateKey.slice(0, 12);
        const ciphertext = encryptedPrivateKey.slice(12);
        
        // Используем Web Crypto API для AES-GCM дешифрования
        const keyMaterialArray = new Uint8Array(keyMaterial);
        const ivArray = new Uint8Array(iv);
        const ciphertextArray = new Uint8Array(ciphertext);
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyMaterialArray.buffer,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );
        
        const decrypted = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: ivArray.buffer,
                tagLength: 128,
            },
            cryptoKey,
            ciphertextArray.buffer
        );
        
        return new Uint8Array(decrypted);
    }

    private async deriveKeyFromPassword(
        password: string,
        salt: Uint8Array
    ): Promise<Uint8Array> {
        // Конвертируем пароль в Uint8Array
        const passwordBytes = naclUtil.decodeUTF8(password);
        
        // Используем Argon2id для KDF
        const key = argon2id(passwordBytes, salt, {
            t: 3,           // 3 итерации
            m: 65536,       // 64 MB памяти
            p: 4,           // 4 параллельных потока
            dkLen: 32,      // 32 байта (256 бит) ключ
        });
        
        return key;
    }

    // ─── Signatures ───
    async signMessage(message: string, secretKey: Uint8Array): Promise<string> {
        const messageBytes = naclUtil.decodeUTF8(message);
        const signature = nacl.sign.detached(messageBytes, secretKey);
        return naclUtil.encodeBase64(signature);
    }

    async verifySignature(
        message: string,
        signature: string,
        publicKey: Uint8Array
    ): Promise<boolean> {
        try {
            const messageBytes = naclUtil.decodeUTF8(message);
            const signatureBytes = naclUtil.decodeBase64(signature);
            return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
        } catch (error) {
            console.error('Signature verification failed:', error);
            return false;
        }
    }

    // ─── Password Hashing ───
    async hashPassword(
        password: string,
        salt?: Uint8Array
    ): Promise<{ hash: string; salt: string }> {
        const saltBytes = salt || randomBytes(16);
        const passwordBytes = naclUtil.decodeUTF8(password);
        
        const hash = argon2id(passwordBytes, saltBytes, {
            t: 3,
            m: 65536,
            p: 4,
            dkLen: 32,
        });
        
        return {
            hash: naclUtil.encodeBase64(hash),
            salt: naclUtil.encodeBase64(saltBytes),
        };
    }

    async verifyPassword(
        password: string,
        hash: string,
        salt: string
    ): Promise<boolean> {
        try {
            const saltBytes = naclUtil.decodeBase64(salt);
            const passwordBytes = naclUtil.decodeUTF8(password);
            
            const computedHash = argon2id(passwordBytes, saltBytes, {
                t: 3,
                m: 65536,
                p: 4,
                dkLen: 32,
            });
            
            const computedHashBase64 = naclUtil.encodeBase64(computedHash);
            return computedHashBase64 === hash;
        } catch (error) {
            console.error('Password verification failed:', error);
            return false;
        }
    }

    // ─── Utilities ───
    bytesToBase64(bytes: Uint8Array): string {
        return naclUtil.encodeBase64(bytes);
    }

    base64ToBytes(base64: string): Uint8Array {
        return naclUtil.decodeBase64(base64);
    }

    bytesToHex(bytes: Uint8Array): string {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    hexToBytes(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    // ─── Random Generation ───
    generateRandomBytes(length: number): Uint8Array {
        return nacl.randomBytes(length);
    }

    generateNonce(): Uint8Array {
        return nacl.randomBytes(nacl.box.nonceLength);
    }

    // ─── Key Validation ───
    validatePublicKey(key: Uint8Array): boolean {
        return key.length === 32; // Curve25519 public keys are 32 bytes
    }

    validatePrivateKey(key: Uint8Array): boolean {
        return key.length === 32; // Curve25519 private keys are 32 bytes
    }

    // ─── Key Conversion ───
    publicKeyToBase64(publicKey: Uint8Array): string {
        return this.bytesToBase64(publicKey);
    }

    base64ToPublicKey(base64: string): Uint8Array {
        const bytes = this.base64ToBytes(base64);
        if (!this.validatePublicKey(bytes)) {
            throw new Error('Invalid public key format');
        }
        return bytes;
    }
}