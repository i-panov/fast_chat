import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useDbStore } from '@/core/db/stores/db.store';
import { useAuthStore } from '@/features/auth/stores/auth.store';
import { channelApi } from '../api/channel-api';
import type { ChannelState, ChannelCreateRequest, ChannelUpdateRequest, ChannelSubscribeRequest, ChannelFilters, ChannelSearchParams } from '../types';
import type { Message } from '@/features/chat/types';

export const useChannelStore = defineStore('channel', () => {
    const dbStore = useDbStore();
    const authStore = useAuthStore();

    // ─── State ───
    const state = ref<ChannelState>({
        channels: [],
        subscriptions: new Map(),
        messages: new Map(),
        activeChannelId: null,
        isLoading: false,
        error: null,
        searchResults: [],
    });

    // ─── Getters ───
    const channels = computed(() => state.value.channels);
    const activeChannelId = computed(() => state.value.activeChannelId);
    const activeChannel = computed(() => {
        if (!state.value.activeChannelId) return null;
        return state.value.channels.find(channel => channel.id === state.value.activeChannelId);
    });
    const activeMessages = computed(() => {
        if (!state.value.activeChannelId) return [];
        return state.value.messages.get(state.value.activeChannelId) || [];
    });
    const subscriptions = computed(() => state.value.subscriptions);
    const searchResults = computed(() => state.value.searchResults);
    const isLoading = computed(() => state.value.isLoading);
    const error = computed(() => state.value.error);
    
    const filteredChannels = computed(() => {
        return (filters: ChannelFilters = {}) => {
            let filtered = [...state.value.channels];
            
            if (filters.query) {
                const queryLower = filters.query.toLowerCase();
                filtered = filtered.filter(channel => 
                    channel.title.toLowerCase().includes(queryLower) ||
                    channel.description?.toLowerCase().includes(queryLower) ||
                    channel.username?.toLowerCase().includes(queryLower)
                );
            }
            
            if (filters.access_level) {
                filtered = filtered.filter(channel => channel.access_level === filters.access_level);
            }
            
            if (filters.subscribed_only) {
                filtered = filtered.filter(channel => channel.is_subscriber);
            }
            
            if (filters.active_only !== false) {
                filtered = filtered.filter(channel => channel.is_active);
            }
            
            return filtered;
        };
    });

    // ─── Actions ───
    async function init() {
        if (!authStore.isAuthenticated) return;
        
        try {
            state.value.isLoading = true;
            await loadChannels();
        } catch (error) {
            console.error('Channel store init failed:', error);
            state.value.error = error instanceof Error ? error.message : 'Failed to initialize channel store';
        } finally {
            state.value.isLoading = false;
        }
    }

    async function loadChannels() {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            // Загружаем с сервера
            const serverChannels = await channelApi.getChannels();
            
            // Синхронизируем с IndexedDB
            await dbStore.syncChannels(serverChannels);
            
            // Обновляем состояние
            state.value.channels = serverChannels;
            
        } catch (error) {
            console.error('Failed to load channels from server, using cached:', error);
            
            // Используем кэшированные данные
            const cachedChannels = await dbStore.getAllChannels();
            state.value.channels = cachedChannels;
        } finally {
            state.value.isLoading = false;
        }
    }

    async function openChannel(channelId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            state.value.activeChannelId = channelId;
            
            // Загружаем сообщения
            await loadChannelMessages(channelId);
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to open channel';
            throw error;
        } finally {
            state.value.isLoading = false;
        }
    }

    async function loadChannelMessages(channelId: string, limit: number = 50) {
        try {
            let serverMessages: Message[];
            
            // Пробуем загрузить с сервера
            try {
                serverMessages = await channelApi.getChannelMessages(channelId, undefined, limit);
                
                // Сохраняем в IndexedDB
                await dbStore.saveMessages(serverMessages);
                
            } catch (serverError) {
                console.error('Failed to load channel messages from server, using cached:', serverError);
                serverMessages = await dbStore.getMessagesByChat(channelId, limit);
            }
            
            // Сохраняем в состояние
            state.value.messages.set(channelId, serverMessages);
            
        } catch (error) {
            console.error('Failed to load channel messages:', error);
            throw error;
        }
    }

    async function createChannel(request: ChannelCreateRequest) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const channel = await channelApi.createChannel(request);
            
            // Добавляем в состояние
            state.value.channels.push(channel);
            
            return { success: true, channel };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to create channel';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function updateChannel(channelId: string, updates: ChannelUpdateRequest) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const channel = await channelApi.updateChannel(channelId, updates);
            
            // Обновляем в состоянии
            const index = state.value.channels.findIndex(c => c.id === channelId);
            if (index >= 0) {
                state.value.channels[index] = channel;
            }
            
            return { success: true, channel };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to update channel';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function deleteChannel(channelId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await channelApi.deleteChannel(channelId);
            
            // Удаляем из состояния
            state.value.channels = state.value.channels.filter(c => c.id !== channelId);
            state.value.messages.delete(channelId);
            
            // Сбрасываем активный канал, если это он
            if (state.value.activeChannelId === channelId) {
                state.value.activeChannelId = null;
            }
            
            // Удаляем из IndexedDB
            await dbStore.deleteChannelLocally(channelId);
            
            return { success: true };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to delete channel';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function subscribeToChannel(channelId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const request: ChannelSubscribeRequest = { channel_id: channelId };
            await channelApi.subscribe(request);
            
            // Обновляем в состоянии
            const channelIndex = state.value.channels.findIndex(c => c.id === channelId);
            if (channelIndex >= 0) {
                const channel = state.value.channels[channelIndex];
                if (channel) {
                    channel.is_subscriber = true;
                    channel.subscribers_count += 1;
                }
            }
            
            return { success: true };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to subscribe to channel';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function unsubscribeFromChannel(channelId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await channelApi.unsubscribe(channelId);
            
            // Обновляем в состоянии
            const channelIndex = state.value.channels.findIndex(c => c.id === channelId);
            if (channelIndex >= 0) {
                const channel = state.value.channels[channelIndex];
                if (channel) {
                    channel.is_subscriber = false;
                    channel.subscribers_count = Math.max(
                        0,
                        channel.subscribers_count - 1
                    );
                }
            }
            
            return { success: true };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to unsubscribe from channel';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function searchChannels(params: ChannelSearchParams) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const results = await channelApi.searchChannels(params);
            state.value.searchResults = results;
            
            return { success: true, results };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to search channels';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function loadSubscribers(channelId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const subscribers = await channelApi.getSubscribers(channelId);
            state.value.subscriptions.set(channelId, subscribers);
            
            return { success: true, subscribers };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to load subscribers';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function approveSubscription(channelId: string, userId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await channelApi.approveRequest(channelId, userId);
            
            // Обновляем в состоянии
            const subscribers = state.value.subscriptions.get(channelId) || [];
            const subscriberIndex = subscribers.findIndex(s => s.user_id === userId);
            if (subscriberIndex >= 0) {
                const subscriber = subscribers[subscriberIndex];
                if (subscriber) {
                    subscriber.status = 'active';
                    state.value.subscriptions.set(channelId, subscribers);
                }
            }
            
            return { success: true };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to approve subscription';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function rejectSubscription(channelId: string, userId: string) {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            await channelApi.rejectRequest(channelId, userId);
            
            // Обновляем в состоянии
            const subscribers = state.value.subscriptions.get(channelId) || [];
            const subscriberIndex = subscribers.findIndex(s => s.user_id === userId);
            if (subscriberIndex >= 0) {
                subscribers.splice(subscriberIndex, 1);
                state.value.subscriptions.set(channelId, subscribers);
            }
            
            return { success: true };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to reject subscription';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    async function sendChannelMessage(channelId: string, content: string, contentType: string = 'text') {
        try {
            state.value.isLoading = true;
            state.value.error = null;
            
            const message = await channelApi.sendChannelMessage({ channel_id: channelId, content, content_type: contentType });
            
            // Добавляем в состояние
            const channelMessages = state.value.messages.get(channelId) || [];
            channelMessages.push(message);
            state.value.messages.set(channelId, channelMessages);
            
            // Обновляем last_message в канале
            const channelIndex = state.value.channels.findIndex(c => c.id === channelId);
            if (channelIndex >= 0) {
                const channel = state.value.channels[channelIndex];
                if (channel) {
                    channel.last_message = message;
                    channel.unread_count = (channel.unread_count || 0) + 1;
                }
            }
            
            return { success: true, message };
            
        } catch (error) {
            state.value.error = error instanceof Error ? error.message : 'Failed to send channel message';
            return { success: false, error: state.value.error };
        } finally {
            state.value.isLoading = false;
        }
    }

    // ─── Return ───
    return {
        // State
        state,
        
        // Getters
        channels,
        activeChannelId,
        activeChannel,
        activeMessages,
        subscriptions,
        searchResults,
        isLoading,
        error,
        filteredChannels,
        
        // Actions
        init,
        loadChannels,
        openChannel,
        loadChannelMessages,
        createChannel,
        updateChannel,
        deleteChannel,
        subscribeToChannel,
        unsubscribeFromChannel,
        searchChannels,
        loadSubscribers,
        approveSubscription,
        rejectSubscription,
        sendChannelMessage,
    };
});