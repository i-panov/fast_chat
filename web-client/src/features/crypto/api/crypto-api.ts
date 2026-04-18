import { httpClient } from '@/core/api/http-client';
import type {
    KeyStatusResponse,
    EncryptedKeyResponse,
    KeySyncRequest,
    KeySyncApproveRequest,
} from '../types';

export class CryptoApi {
    private client = httpClient;

    /**
     * Проверить статус ключа (загружен ли зашифрованный приватный ключ на сервер).
     */
    async checkKeyStatus(): Promise<KeyStatusResponse> {
        return this.client.get('/api/keys/status');
    }

    /**
     * Загрузить зашифрованный приватный ключ на сервер.
     */
    async uploadEncryptedKey(encryptedKey: string): Promise<void> {
        return this.client.post('/api/keys/upload', { encrypted_private_key: encryptedKey });
    }

    /**
     * Скачать зашифрованный приватный ключ с сервера.
     */
    async downloadEncryptedKey(): Promise<EncryptedKeyResponse> {
        return this.client.get('/api/keys/download');
    }

    /**
     * Запросить синхронизацию ключа на новом устройстве.
     */
    async requestKeySync(deviceName?: string): Promise<void> {
        return this.client.post('/api/keys/request-sync', { device_name: deviceName || 'New device' });
    }

    /**
     * Получить список ожидающих запросов синхронизации.
     */
    async getPendingSyncs(): Promise<KeySyncRequest[]> {
        return this.client.get('/api/keys/pending');
    }

    /**
     * Подтвердить синхронизацию ключа (с первого устройства).
     */
    async approveKeySync(request: KeySyncApproveRequest): Promise<void> {
        return this.client.post('/api/keys/approve-sync', request);
    }

    /**
     * Получить публичные ключи участников чата.
     */
    async getChatPublicKeys(chatId: string): Promise<Record<string, string>> {
        return this.client.get(`/api/chats/${chatId}/keys`);
    }

    /**
     * Обновить публичный ключ пользователя.
     */
    async updatePublicKey(publicKey: string): Promise<void> {
        return this.client.post('/api/auth/update-public-key', { public_key: publicKey });
    }
}

export const cryptoApi = new CryptoApi();