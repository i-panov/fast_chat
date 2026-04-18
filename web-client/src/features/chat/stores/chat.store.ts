import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useDbStore } from '@/core/db/stores/db.store';
import { useAuthStore } from '@/features/auth/stores/auth.store';
import { useCryptoStore } from '@/core/crypto/stores/crypto.store';
import { chatApi } from '../api/chat-api';
import type { ChatState, ChatFilters, Message, ChatCreateRequest } from '../types';

export const useChatStore = defineStore('chat', () => {
    const dbStore = useDbStore();
    const authStore = useAuthStore();
    const cryptoStore = useCryptoStore();

    // ─── State ───
    const state = ref<ChatState>({
        chats: [],
        messages: new Map(),
        activeChatId: null,
        typingUsers: new Map(),
        isLoading: false,
        error: null,
        publicKeysCache: new Map(), // chatId -> userId -> publicKey (Uint8Array)
    });

    // ─── Getters ───
    const chats = computed(() => state.value.chats);
    const activeChatId = computed(() => state.value.activeChatId);
    const activeChat = computed(() => {
        if (!state.value.activeChatId) return null;
        return state.value.chats.find(chat => chat.id === state.value.activeChatId);
    });
    const activeMessages = computed(() => {
        if (!state.value.activeChatId) return [];
        return state.value.messages.get(state.value.activeChatId) || [];
    });
    const typingUsers = computed(() => state.value.typingUsers);
    const isLoading = computed(() => state.value.isLoading);
    const error = computed(() => state.value.error);
    const messages = computed(() => state.value.messages);
    
    const filteredChats = computed(() => {
        return (filters: ChatFilters = {}) => {
            let filtered = [...state.value.chats];
            
            if (filters.search) {
                const searchLower = filters.search.toLowerCase();
                filtered = filtered.filter(chat => 
                    chat.name?.toLowerCase().includes(searchLower) ||
                    chat.participants_details?.some(user => 
                        user.username.toLowerCase().includes(searchLower)
                    )
                );
            }
            
            if (filters.favorites_only) {
                filtered = filtered.filter(chat => chat.is_favorites);
            }
            
            if (filters.unread_only) {
                filtered = filtered.filter(chat => (chat.unread_count || 0) > 0);
            }
            
            if (filters.show_hidden === false) {
                filtered = filtered.filter(chat => !chat.hidden);
            }
            
            return filtered;
        };
    });

    // ─── Actions ───
    async function init() {
        if (!authStore.isAuthenticated) return;
        
        try {
            state.value.isLoading = true;
            await loadChats();
        } catch (error) {
            console.error('Chat store init failed:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to initialize chat store';
        } finally {
            state.value.isLoading = false;
        }
    }

    async function loadChats() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            // Загружаем с сервера
            const [serverChats, unreadCounts] = await Promise.all([
                chatApi.getChats(),
                chatApi.getUnreadCounts(),
            ]);
            
            // Объединяем unread counts
            const unreadMap = new Map(unreadCounts.map(u => [u.chat_id, u.count]));
            
            const enrichedChats = serverChats.map(chat => ({
                ...chat,
                unread_count: unreadMap.get(chat.id) || 0,
            }));
            
            // Синхронизируем с IndexedDB
            await dbStore.syncChats(enrichedChats);
            
            // Обновляем состояние
            state.value.chats = enrichedChats;
            
        } catch (error) {
            console.error('Failed to load chats from server, using cached:', error);
            
            // Используем кэшированные данные
            const cachedChats = await dbStore.getAllChats();
            state.value.chats = cachedChats;
        } finally {
            state.value.isLoading = false;
        }
    }

    async function openChat(chatId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            state.value.activeChatId = chatId;
            
            // Отмечаем как прочитанное
            await chatApi.markChatAsRead({ chat_id: chatId });
            await updateChatUnread(chatId, 0);
            
            // Загружаем публичные ключи для шифрования
            await loadPublicKeys(chatId);
            
            // Загружаем сообщения
            await loadMessages(chatId);
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to open chat';
            throw error;
        } finally {
            state.value.isLoading = false;
        }
    }

    async function loadMessages(chatId: string, limit: number = 50) {
        try {
            let serverMessages: Message[];
            
            // Пробуем загрузить с сервера
            try {
                const result = await chatApi.getMessages(chatId, undefined, limit);
                serverMessages = result.messages;
                
                // Расшифровываем сообщения
                if (cryptoStore.hasKeys) {
                    serverMessages = await Promise.all(
                        serverMessages.map(async msg => {
                            if (msg.sender_id !== authStore.user?.id && msg.encrypted_content) {
                                try {
                                    const decrypted = await decryptMessage(msg, chatId);
                                    return { ...msg, encrypted_content: decrypted, is_decrypted: true };
                                } catch (error) {
                                    console.error('Failed to decrypt message:', error);
                                    return { ...msg, encrypted_content: '[Failed to decrypt]' };
                                }
                            }
                            return msg;
                        })
                    );
                }
                
                // Сохраняем в IndexedDB
                await dbStore.saveMessages(serverMessages);
                
            } catch (serverError) {
                console.error('Failed to load messages from server, using cached:', serverError);
                serverMessages = await dbStore.getMessagesByChat(chatId, limit);
            }
            
            // Загружаем pending сообщения
            const pendingMessages = await dbStore.getPendingByChat(chatId);
            const pendingWithIds = pendingMessages.map(pending => ({
                id: pending.id,
                chat_id: pending.chat_id,
                sender_id: authStore.user?.id || '',
                encrypted_content: pending.encrypted_content,
                content_type: pending.content_type,
                file_metadata_id: pending.file_metadata_id,
                status: 'pending' as const,
                edited: false,
                deleted: false,
                created_at: pending.created_at,
                edited_at: null,
                topic_id: pending.topic_id,
                thread_id: pending.thread_id,
                local_pending: true,
            }));
            
            // Объединяем и удаляем дубликаты
            const serverIds = new Set(serverMessages.map(m => m.id));
            const uniquePending = pendingWithIds.filter(p => !serverIds.has(p.id));
            const allMessages = [...serverMessages, ...uniquePending];
            
            // Сортируем по времени
            allMessages.sort((a, b) => a.created_at.localeCompare(b.created_at));
            
            // Сохраняем в состояние
            state.value.messages.set(chatId, allMessages);
            
        } catch (error) {
            console.error('Failed to load messages:', error);
            throw error;
        }
    }

    async function sendMessage(
        chatId: string, 
        content: string, 
        options: {
            contentType?: string;
            fileMetadataId?: string;
            topicId?: string;
            threadId?: string;
        } = {}
    ) {
        try {
            const { contentType = 'text', fileMetadataId, topicId, threadId } = options;
            
            // Создаём локальный ID для pending сообщения
            const localId = crypto.randomUUID();
            
            // Шифруем сообщение для E2E
            let encryptedContent = content;
            const chatItem = state.value.chats.find(c => c.id === chatId);
            
            if (chatItem && !chatItem.is_group && chatItem.participants?.length === 2) {
                const otherUserId = chatItem.participants.find(id => id !== authStore.user?.id);
                if (otherUserId) {
                    const publicKey = await getPublicKey(chatId, otherUserId);
                    if (publicKey) {
                        encryptedContent = await cryptoStore.encryptMessage(content, publicKey);
                    }
                }
            }
            
            // Создаём pending сообщение
            const pendingMessage = {
                id: localId,
                chat_id: chatId,
                encrypted_content: encryptedContent,
                content_type: contentType,
                file_metadata_id: fileMetadataId || null,
                topic_id: topicId || null,
                thread_id: threadId || null,
                created_at: new Date().toISOString(),
                retry_count: 0,
                last_attempt: Date.now(),
            };
            
            // Сохраняем в IndexedDB
            await dbStore.addPendingMessage(pendingMessage);
            
            // Создаём локальное сообщение для UI
            const localMessage: Message = {
                id: localId,
                chat_id: chatId,
                sender_id: authStore.user?.id || '',
                encrypted_content: content, // Показываем оригинальный текст
                content_type: contentType,
                file_metadata_id: fileMetadataId || null,
                status: 'sending',
                edited: false,
                deleted: false,
                created_at: pendingMessage.created_at,
                edited_at: null,
                topic_id: topicId || null,
                thread_id: threadId || null,
                local_pending: true,
            };
            
            // Добавляем в состояние
            const chatMessages = state.value.messages.get(chatId) || [];
            chatMessages.push(localMessage);
            state.value.messages.set(chatId, chatMessages);
            
            // Обновляем last_message в чате
            const chatIndex = state.value.chats.findIndex(c => c.id === chatId);
            const chatItemForMsg = state.value.chats[chatIndex];
            if (chatIndex >= 0 && chatItemForMsg) {
                chatItemForMsg.last_message = localMessage;
                chatItemForMsg.unread_count = (chatItemForMsg.unread_count || 0) + 1;
            }
            
            // Отправляем typing indicator
            await sendTypingIndicator(chatId);
            
            // Пытаемся отправить сразу, если онлайн
            await retryPendingMessages();
            
            return { success: true, localId };
            
        } catch (error) {
            console.error('Failed to send message:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to send message' };
        }
    }

    async function createChat(participantIds: string[], name?: string, isGroup: boolean = false) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const request: ChatCreateRequest = {
                participant_ids: participantIds,
                name,
                is_group: isGroup,
            };
            
            const chat = await chatApi.createChat(request);
            
            // Добавляем в состояние
            state.value.chats.push({
                ...chat,
                unread_count: 0,
            });
            
            return { success: true, chat };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to create chat';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function deleteChat(chatId: string) {
        try {
            // Скрываем на сервере (только для этого пользователя)
            await chatApi.hideChat(chatId);
            
            // Удаляем из состояния
            state.value.chats = state.value.chats.filter(c => c.id !== chatId);
            state.value.messages.delete(chatId);
            
            // Сбрасываем активный чат, если это он
            if (state.value.activeChatId === chatId) {
                state.value.activeChatId = null;
            }
            
            // Удаляем из IndexedDB
            await dbStore.deleteChatLocally(chatId);
            
            return { success: true };
            
        } catch (error) {
            console.error('Failed to delete chat:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to delete chat' };
        }
    }

    async function sendTypingIndicator(chatId: string) {
        try {
            await chatApi.sendTypingIndicator({ chat_id: chatId });
        } catch (error) {
            console.error('Failed to send typing indicator:', error);
        }
    }

    async function updateChatUnread(chatId: string, count: number) {
        const chatIndex = state.value.chats.findIndex(c => c.id === chatId);
        const chatItem = state.value.chats[chatIndex];
        if (chatItem) {
            chatItem.unread_count = count;
            await dbStore.updateChatUnread(chatId, count);
        }
    }

    async function retryPendingMessages() {
        const pending = await dbStore.getPendingMessages();
        const now = Date.now();
        
        for (const msg of pending) {
            if (msg.retry_count >= 5) continue;
            
            const backoff = Math.pow(3, msg.retry_count) * 5000;
            if (now - msg.last_attempt < backoff) continue;
            
            try {
                const sent = await chatApi.sendPendingMessage(msg);
                
                if (sent) {
                    await dbStore.saveMessage(sent);
                    await dbStore.removePendingMessage(msg.id);
                    
                    // Обновляем локальные сообщения
                    const chatMsgs = state.value.messages.get(msg.chat_id) || [];
                    const idx = chatMsgs.findIndex(m => m.id === msg.id);
                    if (idx >= 0) {
                        chatMsgs.splice(idx, 1, sent);
                        state.value.messages.set(msg.chat_id, chatMsgs);
                    }
                } else {
                    await dbStore.updatePendingRetry(msg.id, msg.retry_count + 1, now);
                }
            } catch (error) {
                console.error('Failed to retry pending message:', error);
            }
        }
    }

    // ─── Crypto Helpers ───
    async function loadPublicKeys(chatId: string) {
        try {
            const keys = await chatApi.getChatPublicKeys(chatId);
            const keyMap = new Map<string, Uint8Array>();
            
            Object.entries(keys).forEach(([userId, keyBase64]) => {
                try {
                    const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
                    keyMap.set(userId, keyBytes);
                } catch (error) {
                    console.error('Failed to decode public key for user:', userId, error);
                }
            });
            
            state.value.publicKeysCache.set(chatId, keyMap);
            
        } catch (error) {
            console.error('Failed to load public keys:', error);
            // Создаём пустой map, чтобы не пытаться загружать снова
            state.value.publicKeysCache.set(chatId, new Map());
        }
    }

    async function getPublicKey(chatId: string, userId: string): Promise<Uint8Array | null> {
        let chatKeys = state.value.publicKeysCache.get(chatId);
        
        if (!chatKeys) {
            await loadPublicKeys(chatId);
            chatKeys = state.value.publicKeysCache.get(chatId);
        }
        
        return chatKeys?.get(userId) || null;
    }

    async function decryptMessage(message: Message, chatId: string): Promise<string> {
        if (!message.encrypted_content || !message.sender_id) {
            return message.encrypted_content || '';
        }
        
        if (message.sender_id === authStore.user?.id) {
            // Наши собственные сообщения не нужно расшифровывать
            return message.encrypted_content;
        }
        
        const senderKey = await getPublicKey(chatId, message.sender_id);
        
        if (senderKey) {
            try {
                return await cryptoStore.decryptMessage(message.encrypted_content, senderKey);
            } catch (error) {
                console.error('Failed to decrypt with sender key:', error);
                // Пробуем самодешифровку как fallback
                try {
                    return await cryptoStore.decryptMessage(message.encrypted_content, cryptoStore.keyPair!.publicKey);
                } catch (selfError) {
                    console.error('Self-decryption also failed:', selfError);
                    return '[Failed to decrypt]';
                }
            }
        }
        
        return '[Failed to decrypt - no key]';
    }

    // ─── Return ───
    return {
        // State
        state,
        
        // Getters
        chats,
        activeChatId,
        activeChat,
        activeMessages,
        typingUsers,
        isLoading,
        error,
        filteredChats,
        messages,
        
        // Actions
        init,
        loadChats,
        openChat,
        loadMessages,
        sendMessage,
        createChat,
        deleteChat,
        sendTypingIndicator,
        updateChatUnread,
        retryPendingMessages,
    };
});