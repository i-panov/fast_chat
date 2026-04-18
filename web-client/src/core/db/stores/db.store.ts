import { defineStore } from 'pinia';
import { ref } from 'vue';
import { DbService } from '../services/db.service';
import type { DbState, DbAuth } from '../types';
import type { User, Chat, Message, PendingMessage, Channel, FileMeta } from '@/types';

export const useDbStore = defineStore('db', () => {
    // ─── State ───
    const state = ref<DbState>({
        isInitialized: false,
        isAvailable: false,
        version: 0,
        error: null,
    });

    let dbService: DbService | null = null;

    // ─── Actions ───
    async function init() {
        try {
            dbService = new DbService();
            await dbService.init();
            
            state.value.isInitialized = true;
            state.value.isAvailable = true;
            state.value.version = dbService.getVersion();
            state.value.error = null;
            
        } catch (error) {
            console.error('Failed to initialize database:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to initialize database';
            state.value.isAvailable = false;
        }
    }

    // ─── Auth ───
    async function getAuth(): Promise<DbAuth | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getAuth();
    }

    async function saveAuth(auth: DbAuth): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveAuth(auth);
    }

    async function clearAuth(): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.clearAuth();
    }

    async function updateUser(user: User): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.updateUser(user);
    }

    // ─── Chats ───
    async function getAllChats(): Promise<Chat[]> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getAllChats();
    }

    async function getChat(chatId: string): Promise<Chat | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getChat(chatId);
    }

    async function saveChat(chat: Chat): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveChat(chat);
    }

    async function saveChats(chats: Chat[]): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveChats(chats);
    }

    async function syncChats(serverChats: Chat[]): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.syncChats(serverChats);
    }

    async function updateChatUnread(chatId: string, count: number): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.updateChatUnread(chatId, count);
    }

    async function deleteChatLocally(chatId: string): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.deleteChatLocally(chatId);
    }

    // ─── Messages ───
    async function getMessagesByChat(chatId: string, limit?: number): Promise<Message[]> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getMessagesByChat(chatId, limit);
    }

    async function saveMessage(message: Message): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveMessage(message);
    }

    async function saveMessages(messages: Message[]): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveMessages(messages);
    }

    // ─── Pending Messages ───
    async function getPendingMessages(): Promise<PendingMessage[]> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getPendingMessages();
    }

    async function getPendingByChat(chatId: string): Promise<PendingMessage[]> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getPendingByChat(chatId);
    }

    async function addPendingMessage(message: PendingMessage): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.addPendingMessage(message);
    }

    async function removePendingMessage(messageId: string): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.removePendingMessage(messageId);
    }

    async function updatePendingRetry(messageId: string, retryCount: number, lastAttempt: number): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.updatePendingRetry(messageId, retryCount, lastAttempt);
    }

    // ─── Channels ───
    async function getAllChannels(): Promise<Channel[]> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getAllChannels();
    }

    async function getChannel(channelId: string): Promise<Channel | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getChannel(channelId);
    }

    async function saveChannel(channel: Channel): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveChannel(channel);
    }

    async function saveChannels(channels: Channel[]): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveChannels(channels);
    }

    async function syncChannels(serverChannels: Channel[]): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.syncChannels(serverChannels);
    }

    async function deleteChannelLocally(channelId: string): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.deleteChannelLocally(channelId);
    }

    // ─── Files ───
    async function saveFile(meta: FileMeta, blob: Blob): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveFile(meta, blob);
    }

    async function getFile(fileId: string): Promise<{ meta: FileMeta; blob: Blob } | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getFile(fileId);
    }

    async function deleteFile(fileId: string): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.deleteFile(fileId);
    }

    // ─── Crypto Keys ───
    async function getCsrfToken(): Promise<{ token: string; expires: number } | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getCsrfToken();
    }

    async function saveCsrfToken(tokenData: { token: string; expires: number }): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveCsrfToken(tokenData);
    }

    async function getKeys(): Promise<{ publicKey: string; secretKey: string } | null> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.getKeys();
    }

    async function saveKeys(keys: { publicKey: string; secretKey: string }): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.saveKeys(keys);
    }

    // ─── Utilities ───
    async function clearAll(): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.clearAll();
    }

    async function exportData(): Promise<Blob> {
        if (!dbService) throw new Error('Database not initialized');
        return dbService.exportData();
    }

    async function importData(blob: Blob): Promise<void> {
        if (!dbService) throw new Error('Database not initialized');
        await dbService.importData(blob);
    }

    // ─── Return ───
    return {
        // State
        state,
        
        // Actions
        init,
        
        // Auth
        getAuth,
        saveAuth,
        clearAuth,
        updateUser,
        
        // Chats
        getAllChats,
        getChat,
        saveChat,
        saveChats,
        syncChats,
        updateChatUnread,
        deleteChatLocally,
        
        // Messages
        getMessagesByChat,
        saveMessage,
        saveMessages,
        
        // Pending Messages
        getPendingMessages,
        getPendingByChat,
        addPendingMessage,
        removePendingMessage,
        updatePendingRetry,
        
        // Channels
        getAllChannels,
        getChannel,
        saveChannel,
        saveChannels,
        syncChannels,
        deleteChannelLocally,
        
        // Files
        saveFile,
        getFile,
        deleteFile,
        
        // Crypto
        getCsrfToken,
        saveCsrfToken,
        getKeys,
        saveKeys,
        
        // Utilities
        clearAll,
        exportData,
        importData,
    };
});