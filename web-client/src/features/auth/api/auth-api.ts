import { httpClient, type HttpClient } from '@/core/api/http-client';
import type {
    AuthResponse,
    AuthRequest,
    AuthCodeRequest,
    TwoFactorVerifyRequest,
    TwoFactorSetupResponse,
    BackupCodesResponse,
    RefreshTokenResponse,
    User,
} from '../types';

/**
 * API клиент для аутентификации и управления пользователем.
 * Использует общий HttpClient с токенами и CSRF защитой.
 */
export class AuthApi {
    private readonly client: HttpClient;

    constructor(client?: HttpClient) {
        this.client = client ?? httpClient;
    }

    /**
     * Запросить 6-значный код для входа по email.
     */
    async requestCode(request: AuthCodeRequest): Promise<void> {
        await this.client.post('/api/auth/request-code', request);
    }

    /**
     * Подтвердить код и получить токены.
     * Если требуется 2FA, вернёт need_2fa: true и user_id.
     */
    async verifyCode(request: AuthRequest): Promise<AuthResponse & { need_2fa?: boolean; user_id?: string }> {
        return this.client.post('/api/auth/verify-code', request);
    }

    /**
     * Завершить 2FA аутентификацию.
     */
    async verify2fa(request: TwoFactorVerifyRequest): Promise<AuthResponse> {
        return this.client.post('/api/auth/verify-2fa', request);
    }

    /**
     * Обновить access token с помощью refresh token.
     */
    async refreshTokens(refreshToken: string): Promise<RefreshTokenResponse> {
        return this.client.post('/api/auth/refresh', { refresh_token: refreshToken });
    }

    /**
     * Получить информацию о текущем пользователе.
     */
    async getMe(): Promise<User> {
        return this.client.get('/api/auth/me');
    }

    /**
     * Настроить 2FA (получить секрет и QR-код).
     */
    async setup2fa(): Promise<TwoFactorSetupResponse> {
        return this.client.post('/api/auth/2fa/setup');
    }

    /**
     * Включить 2FA с подтверждением кода.
     */
    async enable2fa(totpCode: string): Promise<void> {
        await this.client.post('/api/auth/2fa/enable', { totp_code: totpCode });
    }

    /**
     * Отключить 2FA (требуется подтверждение по email).
     */
    async disable2fa(): Promise<void> {
        await this.client.post('/api/auth/2fa/disable');
    }

    /**
     * Получить оставшиеся backup codes.
     */
    async getBackupCodes(): Promise<BackupCodesResponse> {
        return this.client.get('/api/auth/2fa/backup-codes');
    }

    /**
     * Сгенерировать новые backup codes (старые становятся недействительными).
     */
    async regenerateBackupCodes(): Promise<BackupCodesResponse> {
        return this.client.post('/api/auth/2fa/backup-codes/regenerate');
    }

    /**
     * Обновить профиль пользователя.
     */
    async updateProfile(updates: Partial<User>): Promise<User> {
        return this.client.put('/api/auth/me', updates);
    }

    /**
     * Выйти (инвалидация токенов на сервере не требуется, клиент просто удаляет токены).
     */
    async logout(): Promise<void> {
        // Серверный logout может быть реализован, но пока просто очищаем токены на клиенте.
        await this.client.clear();
    }
}

/**
 * Экспорт синглтона для удобства.
 */
export const authApi = new AuthApi();