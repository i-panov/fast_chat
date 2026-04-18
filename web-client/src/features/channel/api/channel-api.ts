import { httpClient, type HttpClient } from '@/core/api/http-client';
import type {
    Channel,
    ChannelSubscriber,
    ChannelCreateRequest,
    ChannelUpdateRequest,
    ChannelSubscribeRequest,
    ChannelMessageSendRequest,
    ChannelSearchParams,
} from '../types';
import type { Message } from '@/features/chat/types';

/**
 * API клиент для работы с каналами (broadcast).
 */
export class ChannelApi {
    private readonly client: HttpClient;

    constructor(client?: HttpClient) {
        this.client = client ?? httpClient;
    }

    // ─── Channels ───

    /**
     * Получить список каналов (подписанные или все в зависимости от параметров).
     */
    async getChannels(params?: { subscribed?: boolean }): Promise<Channel[]> {
        const query = new URLSearchParams();
        if (params?.subscribed) query.set('subscribed', 'true');
        return this.client.get(`/api/channels?${query}`);
    }

    /**
     * Поиск публичных каналов.
     */
    async searchChannels(params: ChannelSearchParams): Promise<Channel[]> {
        const query = new URLSearchParams();
        if (params.query) query.set('query', params.query);
        if (params.access_level) query.set('access_level', params.access_level);
        if (params.limit) query.set('limit', params.limit.toString());
        if (params.offset) query.set('offset', params.offset.toString());
        return this.client.get(`/api/channels/search?${query}`);
    }

    /**
     * Получить информацию о канале.
     */
    async getChannel(channelId: string): Promise<Channel> {
        return this.client.get(`/api/channels/${channelId}`);
    }

    /**
     * Создать новый канал.
     */
    async createChannel(request: ChannelCreateRequest): Promise<Channel> {
        return this.client.post('/api/channels', request);
    }

    /**
     * Обновить канал (только владелец).
     */
    async updateChannel(channelId: string, request: ChannelUpdateRequest): Promise<Channel> {
        return this.client.put(`/api/channels/${channelId}`, request);
    }

    /**
     * Удалить канал (только владелец).
     */
    async deleteChannel(channelId: string): Promise<void> {
        await this.client.delete(`/api/channels/${channelId}`);
    }

    // ─── Subscriptions ───

    /**
     * Подписаться на канал (или запросить доступ).
     */
    async subscribe(request: ChannelSubscribeRequest): Promise<void> {
        await this.client.post(`/api/channels/${request.channel_id}/subscribe`);
    }

    /**
     * Отписаться от канала.
     */
    async unsubscribe(channelId: string): Promise<void> {
        await this.client.post(`/api/channels/${channelId}/unsubscribe`);
    }

    /**
     * Получить список подписчиков канала (только владелец).
     */
    async getSubscribers(channelId: string): Promise<ChannelSubscriber[]> {
        return this.client.get(`/api/channels/${channelId}/subscribers`);
    }

    /**
     * Удалить подписчика (только владелец).
     */
    async removeSubscriber(channelId: string, userId: string): Promise<void> {
        await this.client.delete(`/api/channels/${channelId}/subscribers/${userId}`);
    }

    /**
     * Получить список запросов на подписку (для каналов с доступом private_with_approval).
     */
    async getPendingRequests(channelId: string): Promise<ChannelSubscriber[]> {
        return this.client.get(`/api/channels/${channelId}/requests`);
    }

    /**
     * Одобрить запрос на подписку.
     */
    async approveRequest(channelId: string, userId: string): Promise<void> {
        await this.client.post(`/api/channels/${channelId}/requests/${userId}/approve`);
    }

    /**
     * Отклонить запрос на подписку.
     */
    async rejectRequest(channelId: string, userId: string): Promise<void> {
        await this.client.post(`/api/channels/${channelId}/requests/${userId}/reject`);
    }

    // ─── Messages ───

    /**
     * Получить сообщения канала.
     */
    async getChannelMessages(channelId: string, before?: string, limit = 50): Promise<Message[]> {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        params.set('limit', limit.toString());
        return this.client.get(`/api/channels/${channelId}/messages?${params}`);
    }

    /**
     * Отправить сообщение в канал (только владелец).
     */
    async sendChannelMessage(request: ChannelMessageSendRequest): Promise<Message> {
        return this.client.post(`/api/channels/${request.channel_id}/messages`, request);
    }

    /**
     * Удалить сообщение из канала (только владелец).
     */
    async deleteChannelMessage(channelId: string, messageId: string): Promise<void> {
        await this.client.delete(`/api/channels/${channelId}/messages/${messageId}`);
    }
}

/**
 * Экспорт синглтона для удобства.
 */
export const channelApi = new ChannelApi();