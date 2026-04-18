import { defineStore } from 'pinia';
import { ref, computed, onUnmounted } from 'vue';
import { SseService } from '../services/sse.service';
import { useAuthStore } from '@/features/auth/stores/auth.store';
import type { NetworkState, SseEvent, SseConfig, SseEventHandlers } from '../types';

export const useNetworkStore = defineStore('network', () => {
    const authStore = useAuthStore();
    
    // ─── State ───
    const state = ref<NetworkState>({
        isOnline: navigator.onLine,
        lastOnlineCheck: Date.now(),
        connectionType: undefined,
        effectiveType: undefined,
        downlink: undefined,
        rtt: undefined,
    });
    
    // SSE
    const sseService = ref<SseService | null>(null);
    const sseState = ref({
        isConnected: false,
        isConnecting: false,
        lastEventTime: null as number | null,
        reconnectAttempts: 0,
        error: null as string | null,
    });

    // ─── Getters ───
    const isOnline = computed(() => state.value.isOnline);
    const isConnected = computed(() => sseState.value.isConnected);
    const isConnecting = computed(() => sseState.value.isConnecting);
    const lastEventTime = computed(() => sseState.value.lastEventTime);
    const reconnectAttempts = computed(() => sseState.value.reconnectAttempts);
    const error = computed(() => sseState.value.error);
    
    const connectionInfo = computed(() => ({
        type: state.value.connectionType,
        effectiveType: state.value.effectiveType,
        downlink: state.value.downlink,
        rtt: state.value.rtt,
        isOnline: state.value.isOnline,
        lastCheck: state.value.lastOnlineCheck,
    }));

    // ─── Actions ───
    async function init() {
        try {
            // Устанавливаем обработчики онлайн/офлайн
            setupNetworkListeners();
            
            // Если пользователь аутентифицирован, пытаемся подключиться к SSE
            if (authStore.isAuthenticated) {
                await connectSSE();
            }
            
            // Мониторинг соединения
            const conn = navigator.connection;
            if (conn && 'effectiveType' in conn && conn.addEventListener) {
                updateConnectionInfo();
                conn.addEventListener('change', updateConnectionInfo);
            }
            
        } catch (error) {
            console.error('Network store init failed:', error);
        }
    }

    async function connectSSE(handlers?: SseEventHandlers) {
        if (!authStore.isAuthenticated || !authStore.user) {
            throw new Error('User not authenticated');
        }
        
        try {
            sseState.value.isConnecting = true;
            sseState.value.error = null;
            
            const config: SseConfig = {
                url: '/api/sse/connect',
                reconnectInterval: 5000,
                maxReconnectAttempts: 10,
                timeout: 30000,
            };
            
            sseService.value = new SseService(config);
            
            // Настраиваем обработчики событий
            const eventHandlers: SseEventHandlers = {
                onConnect: () => {
                    sseState.value.isConnected = true;
                    sseState.value.isConnecting = false;
                    sseState.value.reconnectAttempts = 0;
                    sseState.value.error = null;
                    console.log('[SSE] Connected');
                },
                onDisconnect: () => {
                    sseState.value.isConnected = false;
                    sseState.value.isConnecting = false;
                    console.log('[SSE] Disconnected');
                },
                onError: (error: Error) => {
                    sseState.value.error = error.message;
                    sseState.value.isConnecting = false;
                    console.error('[SSE] Error:', error);
                },
                ...handlers,
            };
            
            await sseService.value.connect(authStore.accessToken!, eventHandlers);
            
        } catch (error) {
            sseState.value.error = error instanceof Error ? error.message : 'Failed to connect to SSE';
            sseState.value.isConnecting = false;
            console.error('[SSE] Connection failed:', error);
            throw error;
        }
    }

    function disconnectSSE() {
        try {
            if (sseService.value) {
                sseService.value.disconnect();
                sseService.value = null;
            }
            
            sseState.value.isConnected = false;
            sseState.value.isConnecting = false;
            sseState.value.error = null;
            
        } catch (error) {
            console.error('[SSE] Disconnect failed:', error);
        }
    }

    function sendTypingIndicator(chatId: string) {
        if (!sseService.value || !sseState.value.isConnected) {
            console.warn('[SSE] Cannot send typing indicator - SSE not connected');
            return;
        }
        
        // В реальном приложении здесь была бы отправка события
        console.log(`[SSE] Sending typing indicator for chat: ${chatId}`);
    }

    function registerEventHandler<T extends SseEvent['type']>(
        eventType: T,
        _handler: (event: Extract<SseEvent, { type: T }>) => void
    ) {
        if (!sseService.value) {
            console.warn('[SSE] Cannot register event handler - SSE not initialized');
            return;
        }
        
        // В реальном приложении здесь была бы регистрация обработчика
        console.log(`[SSE] Registered handler for event type: ${eventType}`);
    }

    // ─── Network Monitoring ───
    function setupNetworkListeners() {
        const updateOnlineStatus = () => {
            state.value.isOnline = navigator.onLine;
            state.value.lastOnlineCheck = Date.now();
            
            if (state.value.isOnline && authStore.isAuthenticated) {
                // Пытаемся переподключиться к SSE
                setTimeout(() => {
                    if (!sseState.value.isConnected && !sseState.value.isConnecting) {
                        connectSSE().catch(() => {
                            // Игнорируем ошибки при авто-реконнекте
                        });
                    }
                }, 1000);
            }
        };
        
        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        
        // Очистка при уничтожении
        onUnmounted(() => {
            window.removeEventListener('online', updateOnlineStatus);
            window.removeEventListener('offline', updateOnlineStatus);
            
            const conn = navigator.connection;
            if (conn && 'effectiveType' in conn && conn.removeEventListener) {
                conn.removeEventListener('change', updateConnectionInfo);
            }
            
            disconnectSSE();
        });
    }

    function updateConnectionInfo() {
        const conn = navigator.connection;
        if (conn && 'effectiveType' in conn) {
            state.value.connectionType = conn.type as 'wifi' | 'cellular' | 'ethernet' | 'unknown' | undefined;
            state.value.effectiveType = conn.effectiveType;
            state.value.downlink = conn.downlink;
            state.value.rtt = conn.rtt;
        }
    }

    async function checkOnlineStatus(): Promise<boolean> {
        try {
            // Простая проверка доступности сети
            const response = await fetch('/api/health', {
                method: 'HEAD',
                cache: 'no-store',
            });
            
            state.value.isOnline = response.ok;
            state.value.lastOnlineCheck = Date.now();
            
            return response.ok;
        } catch (error) {
            state.value.isOnline = false;
            state.value.lastOnlineCheck = Date.now();
            return false;
        }
    }

    // ─── Retry Logic ───
    async function retryConnection(maxRetries: number = 3, delay: number = 1000): Promise<boolean> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`[Network] Retry attempt ${attempt}/${maxRetries}`);
            
            try {
                await checkOnlineStatus();
                
                if (state.value.isOnline && authStore.isAuthenticated) {
                    await connectSSE();
                    return true;
                }
                
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                }
                
            } catch (error) {
                console.error(`[Network] Retry attempt ${attempt} failed:`, error);
            }
        }
        
        return false;
    }

    // ─── Cleanup ───
    function reset() {
        disconnectSSE();
        sseState.value.reconnectAttempts = 0;
        sseState.value.error = null;
    }

    // ─── Return ───
    return {
        // State
        state,
        sseState,
        
        // Getters
        isOnline,
        isConnected,
        isConnecting,
        lastEventTime,
        reconnectAttempts,
        error,
        connectionInfo,
        
        // Actions
        init,
        connectSSE,
        disconnectSSE,
        sendTypingIndicator,
        registerEventHandler,
        checkOnlineStatus,
        retryConnection,
        reset,
    };
});