import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { CryptoService } from '../services/crypto.service';
import { useDbStore } from '@/core/db/stores/db.store';
import type { CryptoState, KeyPair, KeySyncResponse, BackupEncryption } from '../types';

export const useCryptoStore = defineStore('crypto', () => {
    const dbStore = useDbStore();
    const cryptoService = new CryptoService();

    // ─── State ───
    const state = ref<CryptoState>({
        keyPair: null,
        hasKeys: false,
        isInitialized: false,
        error: null,
    });

    // ─── Getters ───
    const keyPair = computed(() => state.value.keyPair);
    const hasKeys = computed(() => state.value.hasKeys);
    const isInitialized = computed(() => state.value.isInitialized);
    const error = computed(() => state.value.error);
    const publicKeyBase64 = computed(() => {
        if (!state.value.keyPair?.publicKey) return null;
        return cryptoService.bytesToBase64(state.value.keyPair.publicKey);
    });

    // ─── Actions ───
    async function init() {
        try {
            // Пытаемся загрузить ключи из IndexedDB
            const savedKeys = await dbStore.getKeys();
            
            if (savedKeys) {
                // Конвертируем строки обратно в Uint8Array
                const publicKey = cryptoService.base64ToBytes(savedKeys.publicKey);
                const secretKey = cryptoService.base64ToBytes(savedKeys.secretKey);
                
                state.value.keyPair = { publicKey, secretKey };
                state.value.hasKeys = true;
            } else {
                // Генерируем новые ключи
                await generateKeyPair();
            }
            
            state.value.isInitialized = true;
            state.value.error = null;
            
        } catch (error) {
            console.error('Crypto store init failed:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to initialize crypto store';
        }
    }

    async function generateKeyPair(): Promise<KeyPair> {
        try {
            state.value.error = null;
            
            const keyPair = await cryptoService.generateKeyPair();
            state.value.keyPair = keyPair;
            state.value.hasKeys = true;
            
            // Сохраняем в IndexedDB
            await dbStore.saveKeys({
                publicKey: cryptoService.bytesToBase64(keyPair.publicKey),
                secretKey: cryptoService.bytesToBase64(keyPair.secretKey),
            });
            
            return keyPair;
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to generate key pair';
            throw error;
        }
    }

    async function getOrCreateKeypair(): Promise<KeyPair> {
        if (state.value.keyPair) {
            return state.value.keyPair;
        }
        
        return generateKeyPair();
    }

    async function encryptMessage(content: string, recipientPublicKey: Uint8Array): Promise<string> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.encryptMessage(
                content,
                recipientPublicKey,
                state.value.keyPair.secretKey
            );
        } catch (error) {
            console.error('Failed to encrypt message:', error);
            throw new Error('Encryption failed');
        }
    }

    async function decryptMessage(encryptedContent: string, senderPublicKey: Uint8Array): Promise<string> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.decryptMessage(
                encryptedContent,
                senderPublicKey,
                state.value.keyPair.secretKey
            );
        } catch (error) {
            console.error('Failed to decrypt message:', error);
            throw new Error('Decryption failed');
        }
    }

    async function encryptForSelf(content: string): Promise<string> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.encryptMessage(
                content,
                state.value.keyPair.publicKey,
                state.value.keyPair.secretKey
            );
        } catch (error) {
            console.error('Failed to encrypt for self:', error);
            throw new Error('Self-encryption failed');
        }
    }

    async function decryptFromSelf(encryptedContent: string): Promise<string> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.decryptMessage(
                encryptedContent,
                state.value.keyPair.publicKey,
                state.value.keyPair.secretKey
            );
        } catch (error) {
            console.error('Failed to decrypt from self:', error);
            throw new Error('Self-decryption failed');
        }
    }

    async function exportEncryptedPrivateKey(password: string): Promise<BackupEncryption> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.encryptPrivateKey(
                state.value.keyPair.secretKey,
                password
            );
        } catch (error) {
            console.error('Failed to export encrypted private key:', error);
            throw new Error('Export failed');
        }
    }

    async function importEncryptedPrivateKey(encryptedData: BackupEncryption, password: string): Promise<void> {
        try {
            await cryptoService.decryptPrivateKey(encryptedData, password);
            
            // TODO: использовать расшифрованный приватный ключ вместо генерации новой пары
            // Нужно получить соответствующий публичный ключ или сгенерировать новую пару
            // Для простоты генерируем новую пару
            await generateKeyPair();
            
        } catch (error) {
            console.error('Failed to import encrypted private key:', error);
            throw new Error('Import failed - wrong password or corrupted data');
        }
    }

    async function requestKeySync(_deviceName: string, _userId: string): Promise<KeySyncResponse> {
        try {
            state.value.error = null;
            
            // В реальном приложении здесь был бы вызов API
            // Для демо возвращаем mock response
            const response: KeySyncResponse = {
                code: Math.random().toString(36).substring(2, 8).toUpperCase(),
                expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 минут
            };
            
            return response;
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to request key sync';
            throw error;
        }
    }

    async function approveKeySync(code: string, _userId: string): Promise<boolean> {
        try {
            state.value.error = null;
            
            // В реальном приложении здесь был бы вызов API
            // Для демо просто проверяем что код не пустой
            if (!code.trim()) {
                throw new Error('Invalid code');
            }
            
            return true;
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to approve key sync';
            throw error;
        }
    }

    async function signMessage(message: string): Promise<string> {
        if (!state.value.keyPair) {
            throw new Error('No key pair available');
        }
        
        try {
            return await cryptoService.signMessage(
                message,
                state.value.keyPair.secretKey
            );
        } catch (error) {
            console.error('Failed to sign message:', error);
            throw new Error('Signing failed');
        }
    }

    async function verifySignature(message: string, signature: string, publicKey: Uint8Array): Promise<boolean> {
        try {
            return await cryptoService.verifySignature(
                message,
                signature,
                publicKey
            );
        } catch (error) {
            console.error('Failed to verify signature:', error);
            return false;
        }
    }

    async function hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: string; salt: string }> {
        try {
            return await cryptoService.hashPassword(password, salt);
        } catch (error) {
            console.error('Failed to hash password:', error);
            throw new Error('Hashing failed');
        }
    }

    async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
        try {
            return await cryptoService.verifyPassword(password, hash, salt);
        } catch (error) {
            console.error('Failed to verify password:', error);
            return false;
        }
    }

    async function clearKeys() {
        try {
            // Очищаем из IndexedDB
            await dbStore.saveKeys({
                publicKey: '',
                secretKey: '',
            });
            
            // Сбрасываем состояние
            state.value.keyPair = null;
            state.value.hasKeys = false;
            state.value.error = null;
            
        } catch (error) {
            console.error('Failed to clear keys:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to clear keys';
        }
    }

    // ─── Return ───
    return {
        // State
        state,
        
        // Getters
        keyPair,
        hasKeys,
        isInitialized,
        error,
        publicKeyBase64,
        
        // Actions
        init,
        generateKeyPair,
        getOrCreateKeypair,
        encryptMessage,
        decryptMessage,
        encryptForSelf,
        decryptFromSelf,
        exportEncryptedPrivateKey,
        importEncryptedPrivateKey,
        requestKeySync,
        approveKeySync,
        signMessage,
        verifySignature,
        hashPassword,
        verifyPassword,
        clearKeys,
    };
});