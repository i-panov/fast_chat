import { httpClient, type HttpClient } from '@/core/api/http-client';
import type {
    Chat,
    Message,
    Topic,
    Thread,
    PinnedMessage,
    UnreadCount,
    ChatCreateRequest,
    MessageSendRequest,
    MessageUpdateRequest,
    TypingIndicatorRequest,
    MarkReadRequest,
} from '../types';
import type { PendingMessage } from '@/types';

/**
 * API клиент для работы с чатами и сообщениями.
 */
export class ChatApi {
    private readonly client: HttpClient;

    constructor(client?: HttpClient) {
        this.client = client ?? httpClient;
    }

    // ─── Chats ───

    /**
     * Получить список чатов текущего пользователя.
     */
    async getChats(): Promise<Chat[]> {
        return this.client.get('/api/chats');
    }

    /**
     * Получить информацию о конкретном чате.
     */
    async getChat(chatId: string): Promise<Chat> {
        return this.client.get(`/api/chats/${chatId}`);
    }

    /**
     * Создать новый чат (личный или групповой).
     */
    async createChat(request: ChatCreateRequest): Promise<Chat> {
        return this.client.post('/api/chats', request);
    }

    /**
     * Обновить информацию о чате (например, название).
     */
    async updateChat(chatId: string, updates: Partial<Chat>): Promise<Chat> {
        return this.client.put(`/api/chats/${chatId}`, updates);
    }

    /**
     * Удалить чат (только для групповых чатов, если вы создатель).
     */
    async deleteChat(chatId: string): Promise<void> {
        await this.client.delete(`/api/chats/${chatId}`);
    }

    /**
     * Скрыть чат для текущего пользователя (архивация).
     */
    async hideChat(chatId: string): Promise<{ success: boolean; message: string }> {
        return this.client.post(`/api/chats/${chatId}/hide`);
    }

    /**
     * Добавить участника в чат.
     */
    async addParticipant(chatId: string, userId: string): Promise<void> {
        await this.client.post(`/api/chats/${chatId}/participants`, { user_id: userId });
    }

    /**
     * Удалить участника из чата.
     */
    async removeParticipant(chatId: string, userId: string): Promise<void> {
        await this.client.delete(`/api/chats/${chatId}/participants/${userId}`);
    }

    /**
     * Покинуть чат.
     */
    async leaveChat(chatId: string): Promise<void> {
        await this.client.delete(`/api/chats/${chatId}/leave`);
    }

    // ─── Messages ───

    /**
     * Получить сообщения из чата с пагинацией.
     * @param chatId ID чата
     * @param before Идентификатор сообщения, до которого загружать (опционально)
     * @param limit Количество сообщений (по умолчанию 50)
     */
    async getMessages(chatId: string, before?: string, limit = 50): Promise<{
        messages: Message[];
        has_more: boolean;
        next_cursor: string;
    }> {
        const params = new URLSearchParams();
        if (before) params.set('before', before);
        params.set('limit', limit.toString());
        return this.client.get(`/api/chats/${chatId}/messages?${params}`);
    }

    /**
     * Отправить сообщение в чат.
     */
    async sendMessage(request: MessageSendRequest): Promise<Message> {
        return this.client.post('/api/messages', request);
    }

    /**
     * Отправить отложенное сообщение (используется для повторной отправки).
     */
    async sendPendingMessage(pending: PendingMessage): Promise<Message | null> {
        try {
            const request: MessageSendRequest = {
                chat_id: pending.chat_id,
                content: '', // обязательное поле, но не используется при наличии encrypted_content
                encrypted_content: pending.encrypted_content,
                content_type: pending.content_type,
                file_metadata_id: pending.file_metadata_id ?? undefined,
                topic_id: pending.topic_id ?? undefined,
                thread_id: pending.thread_id ?? undefined,
            };
            return await this.sendMessage(request);
        } catch {
            return null;
        }
    }

    /**
     * Редактировать сообщение.
     */
    async editMessage(messageId: string, request: MessageUpdateRequest): Promise<Message> {
        return this.client.put(`/api/messages/${messageId}`, request);
    }

    /**
     * Удалить сообщение (мягкое удаление).
     */
    async deleteMessage(messageId: string): Promise<void> {
        await this.client.delete(`/api/messages/${messageId}`);
    }

    /**
     * Получить информацию о сообщении.
     */
    async getMessage(messageId: string): Promise<Message> {
        return this.client.get(`/api/messages/${messageId}`);
    }

    // ─── Typing Indicators ───

    /**
     * Отправить индикатор набора текста.
     */
    async sendTypingIndicator(request: TypingIndicatorRequest): Promise<void> {
        await this.client.post('/api/typing', request);
    }

    // ─── Read Receipts ───

    /**
     * Отметить чат как прочитанный.
     */
    async markChatAsRead(request: MarkReadRequest): Promise<void> {
        await this.client.post('/api/chats/read', request);
    }

    /**
     * Получить количество непрочитанных сообщений по чатам.
     */
    async getUnreadCounts(): Promise<UnreadCount[]> {
        return this.client.get('/api/unread');
    }

    // ─── Topics ───

    /**
     * Получить список тем в чате.
     */
    async getTopics(chatId: string): Promise<Topic[]> {
        return this.client.get(`/api/topics?chat_id=${chatId}`);
    }

    /**
     * Создать тему в чате.
     */
    async createTopic(chatId: string, name: string): Promise<Topic> {
        return this.client.post('/api/topics', { chat_id: chatId, name });
    }

    /**
     * Удалить тему.
     */
    async deleteTopic(topicId: string): Promise<void> {
        await this.client.delete(`/api/topics/${topicId}`);
    }

    // ─── Threads ───

    /**
     * Получить тред по ID.
     */
    async getThread(threadId: string): Promise<Thread> {
        return this.client.get(`/api/threads/${threadId}`);
    }

    /**
     * Получить сообщения в треде.
     */
    async getThreadMessages(threadId: string): Promise<Message[]> {
        return this.client.get(`/api/threads/${threadId}/messages`);
    }

    /**
     * Создать тред (ответ на сообщение).
     */
    async createThread(chatId: string, rootMessageId: string): Promise<Thread> {
        return this.client.post('/api/threads', { chat_id: chatId, root_message_id: rootMessageId });
    }

    // ─── Pinned Messages ───

    /**
     * Получить закреплённые сообщения в чате.
     */
    async getPinnedMessages(chatId: string): Promise<PinnedMessage[]> {
        return this.client.get(`/api/chats/${chatId}/pins`);
    }

    /**
     * Закрепить сообщение.
     */
    async pinMessage(chatId: string, messageId: string): Promise<PinnedMessage> {
        return this.client.post(`/api/chats/${chatId}/pins`, { message_id: messageId });
    }

    /**
     * Открепить сообщение.
     */
    async unpinMessage(pinId: string): Promise<void> {
        await this.client.delete(`/api/pins/${pinId}`);
    }

    // ─── E2E Keys ───

    /**
     * Получить публичные ключи участников чата.
     */
    async getChatPublicKeys(chatId: string): Promise<Record<string, string>> {
        return this.client.get(`/api/chats/${chatId}/keys`);
    }
}

/**
 * Экспорт синглтона для удобства.
 */
export const chatApi = new ChatApi();