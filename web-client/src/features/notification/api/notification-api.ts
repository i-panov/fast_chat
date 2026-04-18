import { httpClient } from '@/core/api/http-client';
import type {
    PushSubscriptionCreateRequest,
    VapidPublicKeyResponse,
    NotificationSettings,
    MutedChat,
    PushSubscription,
} from '../types';

export class NotificationApi {
    private client = httpClient;

    /**
     * Получить VAPID публичный ключ для Web Push.
     */
    async getVapidPublicKey(): Promise<VapidPublicKeyResponse> {
        return this.client.get('/api/push/vapid-public-key');
    }

    /**
     * Подписаться на push-уведомления.
     */
    async subscribePush(request: PushSubscriptionCreateRequest): Promise<{ success: boolean }> {
        return this.client.post('/api/push/subscribe', request);
    }

    /**
     * Получить список подписок текущего пользователя.
     */
    async getSubscriptions(): Promise<PushSubscription[]> {
        return this.client.get('/api/push/subscriptions');
    }

    /**
     * Удалить подписку по ID.
     */
    async deleteSubscription(subscriptionId: string): Promise<void> {
        return this.client.delete(`/api/push/subscriptions/${subscriptionId}`);
    }

    /**
     * Получить настройки уведомлений.
     */
    async getSettings(): Promise<NotificationSettings> {
        return this.client.get('/api/notifications/settings');
    }

    /**
     * Обновить настройки уведомлений.
     */
    async updateSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings> {
        return this.client.put('/api/notifications/settings', settings);
    }

    /**
     * Получить список заглушённых чатов/каналов.
     */
    async getMutedChats(): Promise<MutedChat[]> {
        return this.client.get('/api/notifications/muted');
    }

    /**
     * Заглушить чат или канал.
     */
    async muteChat(request: { chat_id?: string; channel_id?: string; muted_until?: string }): Promise<void> {
        return this.client.post('/api/notifications/mute', request);
    }

    /**
     * Разглушить чат или канал.
     */
    async unmuteChat(request: { chat_id?: string; channel_id?: string }): Promise<void> {
        return this.client.post('/api/notifications/unmute', request);
    }

    /**
     * Отправить тестовое push-уведомление.
     */
    async sendTestPush(): Promise<void> {
        return this.client.post('/api/notifications/test-push');
    }
}

export const notificationApi = new NotificationApi();