import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { 
    User, Chat, Message, Channel, FileMeta, PendingMessage,
    DbAuth, DbUser, DbChat, DbMessage, DbPendingMessage, DbChannel, DbFileMetadata 
} from '../types';

interface FastChatDB extends DBSchema {
    users: {
        key: string;
        value: DbUser;
    };
    chats: {
        key: string;
        value: DbChat;
        indexes: { 'by-updated': string };
    };
    messages: {
        key: string;
        value: DbMessage;
        indexes: { 'by-chat': [string, string] };
    };
    channels: {
        key: string;
        value: DbChannel;
    };
    pending_messages: {
        key: string;
        value: DbPendingMessage;
        indexes: { 'by-chat': string };
    };
    files: {
        key: string;
        value: { meta: DbFileMetadata; blob: Blob };
    };
    auth: {
        key: string;
        value: DbAuth;
    };
    keys: {
        key: string;
        value: {
            publicKey: string;
            secretKey: string;
        };
    };
    csrf_token: {
        key: string;
        value: {
            token: string;
            expires: number;
        };
    };
}

const DB_NAME = 'fast-chat-db';
const DB_VERSION = 4; // Увеличиваем версию для новой схемы

export class DbService {
    private db: IDBPDatabase<FastChatDB> | null = null;
    private dbPromise: Promise<IDBPDatabase<FastChatDB>> | null = null;

    async init(): Promise<void> {
        if (this.dbPromise) {
            await this.dbPromise;
            return;
        }

        this.dbPromise = openDB<FastChatDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion) {
                // Миграции
                if (oldVersion < 4) {
                    // Удаляем старые stores если они существуют
                    if (db.objectStoreNames.contains('users')) {
                        db.deleteObjectStore('users');
                    }
                    if (db.objectStoreNames.contains('chats')) {
                        db.deleteObjectStore('chats');
                    }
                    if (db.objectStoreNames.contains('messages')) {
                        db.deleteObjectStore('messages');
                    }
                    if (db.objectStoreNames.contains('channels')) {
                        db.deleteObjectStore('channels');
                    }
                    if (db.objectStoreNames.contains('pending_messages')) {
                        db.deleteObjectStore('pending_messages');
                    }
                    if (db.objectStoreNames.contains('files')) {
                        db.deleteObjectStore('files');
                    }
                    if (db.objectStoreNames.contains('auth')) {
                        db.deleteObjectStore('auth');
                    }
                    if (db.objectStoreNames.contains('keys')) {
                        db.deleteObjectStore('keys');
                    }
                    if (db.objectStoreNames.contains('csrf_token')) {
                        db.deleteObjectStore('csrf_token');
                    }

                    // Создаём новые stores
                    db.createObjectStore('users');
                    
                    const chatsStore = db.createObjectStore('chats');
                    chatsStore.createIndex('by-updated', 'updated_at');
                    
                    const messagesStore = db.createObjectStore('messages');
                    messagesStore.createIndex('by-chat', ['chat_id', 'created_at']);
                    
                    db.createObjectStore('channels');
                    
                    const pendingStore = db.createObjectStore('pending_messages');
                    pendingStore.createIndex('by-chat', 'chat_id');
                    
                    db.createObjectStore('files');
                    db.createObjectStore('auth');
                    db.createObjectStore('keys');
                    db.createObjectStore('csrf_token');
                }
            },
        });

        this.db = await this.dbPromise;
    }

    getVersion(): number {
        return DB_VERSION;
    }

    // ─── Auth ───
    async getAuth(): Promise<DbAuth | null> {
        if (!this.db) throw new Error('Database not initialized');
        const auth = await this.db.get('auth', 'current');
        return auth ?? null;
    }

    async saveAuth(auth: DbAuth): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.put('auth', auth, 'current');
    }

    async clearAuth(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.delete('auth', 'current');
    }

    async updateUser(user: User): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const dbUser: DbUser = {
            ...user,
            last_sync: new Date().toISOString(),
        };
        await this.db.put('users', dbUser, user.id);
    }

    // ─── Chats ───
    async getAllChats(): Promise<Chat[]> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChats = await this.db.getAll('chats');
        return dbChats.map(chat => this.convertDbChatToChat(chat));
    }

    async getChat(chatId: string): Promise<Chat | null> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChat = await this.db.get('chats', chatId);
        return dbChat ? this.convertDbChatToChat(dbChat) : null;
    }

    async saveChat(chat: Chat): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChat: DbChat = {
            ...chat,
            last_sync: new Date().toISOString(),
        };
        await this.db.put('chats', dbChat, chat.id);
    }

    async saveChats(chats: Chat[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const tx = this.db.transaction('chats', 'readwrite');
        await Promise.all([
            ...chats.map(chat => {
                const dbChat: DbChat = {
                    ...chat,
                    last_sync: new Date().toISOString(),
                };
                return tx.store.put(dbChat, chat.id);
            }),
            tx.done,
        ]);
    }

    async syncChats(serverChats: Chat[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Получаем существующие чаты
        const existingChats = await this.getAllChats();
        const existingChatsMap = new Map(existingChats.map(chat => [chat.id, chat]));
        
        // Обновляем или добавляем новые
        const tx = this.db.transaction('chats', 'readwrite');
        
        for (const serverChat of serverChats) {
            const existing = existingChatsMap.get(serverChat.id);
            const dbChat: DbChat = {
                ...serverChat,
                last_sync: new Date().toISOString(),
                hidden_at: (existing as DbChat)?.hidden_at,
            };
            await tx.store.put(dbChat, serverChat.id);
        }
        
        await tx.done;
    }

    async updateChatUnread(chatId: string, count: number): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const chat = await this.getChat(chatId);
        if (chat) {
            chat.unread_count = count;
            await this.saveChat(chat);
        }
    }

    async deleteChatLocally(chatId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Удаляем чат
        await this.db.delete('chats', chatId);
        
        // Удаляем сообщения этого чата
        const messages = await this.getMessagesByChat(chatId);
        const tx = this.db.transaction('messages', 'readwrite');
        await Promise.all([
            ...messages.map(msg => tx.store.delete(msg.id)),
            tx.done,
        ]);
        
        // Удаляем pending сообщения
        const pendingTx = this.db.transaction('pending_messages', 'readwrite');
        const pendingMessages = await pendingTx.store.index('by-chat').getAll(chatId);
        await Promise.all([
            ...pendingMessages.map(msg => pendingTx.store.delete(msg.id)),
            pendingTx.done,
        ]);
    }

    // ─── Messages ───
    async getMessagesByChat(chatId: string, limit?: number): Promise<Message[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        const index = this.db.transaction('messages').store.index('by-chat');
        const range = IDBKeyRange.bound([chatId, ''], [chatId, '\uffff']);
        
        let messages = await index.getAll(range);
        
        // Сортируем по времени (по убыванию)
        messages.sort((a, b) => b.created_at.localeCompare(a.created_at));
        
        // Применяем лимит если указан
        if (limit) {
            messages = messages.slice(0, limit);
        }
        
        // Сортируем обратно для отображения (по возрастанию)
        messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
        
        return messages.map(msg => this.convertDbMessageToMessage(msg));
    }

    async saveMessage(message: Message): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const dbMessage: DbMessage = {
            ...message,
            is_synced: true,
            sync_attempts: 0,
        };
        await this.db.put('messages', dbMessage, message.id);
    }

    async saveMessages(messages: Message[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const tx = this.db.transaction('messages', 'readwrite');
        await Promise.all([
            ...messages.map(message => {
                const dbMessage: DbMessage = {
                    ...message,
                    is_synced: true,
                    sync_attempts: 0,
                };
                return tx.store.put(dbMessage, message.id);
            }),
            tx.done,
        ]);
    }

    // ─── Pending Messages ───
    async getPendingMessages(): Promise<PendingMessage[]> {
        if (!this.db) throw new Error('Database not initialized');
        return this.db.getAll('pending_messages');
    }

    async getPendingByChat(chatId: string): Promise<PendingMessage[]> {
        if (!this.db) throw new Error('Database not initialized');
        const index = this.db.transaction('pending_messages').store.index('by-chat');
        return index.getAll(chatId);
    }

    async addPendingMessage(message: PendingMessage): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.add('pending_messages', message);
    }

    async removePendingMessage(messageId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.delete('pending_messages', messageId);
    }

    async updatePendingRetry(messageId: string, retryCount: number, lastAttempt: number): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const message = await this.db.get('pending_messages', messageId);
        if (message) {
            message.retry_count = retryCount;
            message.last_attempt = lastAttempt;
            await this.db.put('pending_messages', message, messageId);
        }
    }

    // ─── Channels ───
    async getAllChannels(): Promise<Channel[]> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChannels = await this.db.getAll('channels');
        return dbChannels.map(channel => this.convertDbChannelToChannel(channel));
    }

    async getChannel(channelId: string): Promise<Channel | null> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChannel = await this.db.get('channels', channelId);
        return dbChannel ? this.convertDbChannelToChannel(dbChannel) : null;
    }

    async saveChannel(channel: Channel): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const dbChannel: DbChannel = {
            ...channel,
            last_sync: new Date().toISOString(),
        };
        await this.db.put('channels', dbChannel, channel.id);
    }

    async saveChannels(channels: Channel[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const tx = this.db.transaction('channels', 'readwrite');
        await Promise.all([
            ...channels.map(channel => {
                const dbChannel: DbChannel = {
                    ...channel,
                    last_sync: new Date().toISOString(),
                };
                return tx.store.put(dbChannel, channel.id);
            }),
            tx.done,
        ]);
    }

    async syncChannels(serverChannels: Channel[]): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Получаем существующие каналы
        const existingChannels = await this.getAllChannels();
        const existingChannelsMap = new Map(existingChannels.map(channel => [channel.id, channel]));
        
        // Обновляем или добавляем новые
        const tx = this.db.transaction('channels', 'readwrite');
        
        for (const serverChannel of serverChannels) {
            const existing = existingChannelsMap.get(serverChannel.id);
            const dbChannel: DbChannel = {
                ...serverChannel,
                last_sync: new Date().toISOString(),
                last_message_sync: (existing as DbChannel)?.last_message_sync,
            };
            await tx.store.put(dbChannel, serverChannel.id);
        }
        
        await tx.done;
    }

    async deleteChannelLocally(channelId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // Удаляем канал
        await this.db.delete('channels', channelId);
        
        // Удаляем сообщения этого канала
        const messages = await this.getMessagesByChat(channelId);
        const tx = this.db.transaction('messages', 'readwrite');
        await Promise.all([
            ...messages.map(msg => tx.store.delete(msg.id)),
            tx.done,
        ]);
    }

    // ─── Files ───
    async saveFile(meta: FileMeta, blob: Blob): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        const dbFileMeta: DbFileMetadata = {
            ...meta,
            local_path: undefined,
            is_downloaded: false,
            download_path: undefined,
        };
        await this.db.put('files', { meta: dbFileMeta, blob }, meta.id);
    }

    async getFile(fileId: string): Promise<{ meta: FileMeta; blob: Blob } | null> {
        if (!this.db) throw new Error('Database not initialized');
        const result = await this.db.get('files', fileId);
        if (!result) return null;
        
        return {
            meta: this.convertDbFileMetaToFileMeta(result.meta),
            blob: result.blob,
        };
    }

    async deleteFile(fileId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.delete('files', fileId);
    }

    // ─── Crypto ───
    async getCsrfToken(): Promise<{ token: string; expires: number } | null> {
        if (!this.db) throw new Error('Database not initialized');
        const token = await this.db.get('csrf_token', 'current');
        return token ?? null;
    }

    async saveCsrfToken(tokenData: { token: string; expires: number }): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.put('csrf_token', tokenData, 'current');
    }

    async getKeys(): Promise<{ publicKey: string; secretKey: string } | null> {
        if (!this.db) throw new Error('Database not initialized');
        const keys = await this.db.get('keys', 'current');
        return keys ?? null;
    }

    async saveKeys(keys: { publicKey: string; secretKey: string }): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        await this.db.put('keys', keys, 'current');
    }

    // ─── Utilities ───
    async clearAll(): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores = Array.from(this.db.objectStoreNames) as any[];
        const tx = this.db.transaction(stores, 'readwrite');
        
        await Promise.all([
            ...stores.map((storeName: string) => tx.objectStore(storeName).clear()),
            tx.done,
        ]);
    }

    async exportData(): Promise<Blob> {
        if (!this.db) throw new Error('Database not initialized');
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const exportData: Record<string, any[]> = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores = Array.from(this.db.objectStoreNames) as any[];
        
        for (const storeName of stores) {
            const data = await this.db.getAll(storeName);
            exportData[storeName] = data;
        }
        
        return new Blob([JSON.stringify(exportData, null, 2)], {
            type: 'application/json',
        });
    }

    async importData(blob: Blob): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        const text = await blob.text();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const importData = JSON.parse(text) as Record<string, any[]>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stores = Array.from(this.db.objectStoreNames) as any[];
        const tx = this.db.transaction(stores, 'readwrite');
        
        for (const storeName of stores) {
            const data = importData[storeName];
            if (data && Array.isArray(data)) {
                const store = tx.objectStore(storeName);
                for (const item of data) {
                    await store.put(item);
                }
            }
        }
        
        await tx.done;
    }

    // ─── Private Converters ───
    private convertDbChatToChat(dbChat: DbChat): Chat {
        const { last_sync, hidden_at, ...chat } = dbChat;
        return chat;
    }

    private convertDbMessageToMessage(dbMessage: DbMessage): Message {
        const { is_synced, sync_failed, sync_attempts, ...message } = dbMessage;
        return message;
    }

    private convertDbChannelToChannel(dbChannel: DbChannel): Channel {
        const { last_sync, last_message_sync, ...channel } = dbChannel;
        return channel;
    }

    private convertDbFileMetaToFileMeta(dbFileMeta: DbFileMetadata): FileMeta {
        const { local_path, is_downloaded, download_path, ...meta } = dbFileMeta;
        return meta;
    }
}