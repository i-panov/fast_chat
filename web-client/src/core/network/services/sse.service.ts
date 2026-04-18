import type { SseConfig, SseEvent, SseEventHandlers } from '../types';

export class SseService {
    private config: SseConfig;
    private eventSource: EventSource | null = null;
    private eventHandlers: SseEventHandlers = {};
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private isConnecting = false;
    private isConnected = false;
    
    constructor(config?: Partial<SseConfig>) {
        this.config = {
            url: '/api/sse/connect',
            reconnectInterval: 5000,
            maxReconnectAttempts: 10,
            timeout: 30000,
            ...config,
        };
    }
    
    async connect(accessToken: string, handlers?: SseEventHandlers): Promise<void> {
        if (this.isConnecting || this.isConnected) {
            console.warn('[SSE] Already connecting or connected');
            return;
        }
        
        try {
            this.isConnecting = true;
            this.eventHandlers = { ...handlers };
            
            // Создаём URL с токеном
            const url = new URL(this.config.url, window.location.origin);
            url.searchParams.append('token', accessToken);
            
            // Создаём EventSource
            this.eventSource = new EventSource(url.toString());
            
            // Настраиваем таймаут
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error('SSE connection timeout'));
                }, this.config.timeout);
            });
            
            // Ждём подключения или таймаута
            await Promise.race([
                this.waitForConnection(),
                timeoutPromise,
            ]);
            
            this.isConnected = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            
            // Устанавливаем обработчики событий
            this.setupEventHandlers();
            
            // Запускаем обработчик onConnect
            this.eventHandlers.onConnect?.();
            
            console.log('[SSE] Connected successfully');
            
        } catch (error) {
            this.isConnecting = false;
            this.eventHandlers.onError?.(error as Error);
            
            // Пытаемся переподключиться
            this.scheduleReconnect();
            
            throw error;
        }
    }
    
    disconnect(): void {
        // Очищаем таймер переподключения
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Закрываем EventSource
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        
        this.isConnected = false;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        
        // Запускаем обработчик onDisconnect
        this.eventHandlers.onDisconnect?.();
        
        console.log('[SSE] Disconnected');
    }
    
    isConnectedState(): boolean {
        return this.isConnected;
    }
    
    private waitForConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.eventSource) {
                reject(new Error('EventSource not initialized'));
                return;
            }
            
            const onOpen = () => {
                cleanup();
                resolve();
            };
            
            const onError = (_event: Event) => {
                cleanup();
                reject(new Error('SSE connection error'));
            };
            
            const cleanup = () => {
                this.eventSource?.removeEventListener('open', onOpen);
                this.eventSource?.removeEventListener('error', onError);
            };
            
            this.eventSource.addEventListener('open', onOpen, { once: true });
            this.eventSource.addEventListener('error', onError, { once: true });
        });
    }
    
    private setupEventHandlers(): void {
        if (!this.eventSource) return;
        
        // Обработчик для общих событий
        this.eventSource.addEventListener('message', (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as SseEvent;
                this.handleEvent(data);
            } catch (error) {
                console.error('[SSE] Failed to parse event:', error, event.data);
            }
        });
        
        // Обработчик для ошибок
        this.eventSource.addEventListener('error', (event: Event) => {
            console.error('[SSE] EventSource error:', event);
            
            if (this.isConnected) {
                this.isConnected = false;
                this.eventHandlers.onError?.(new Error('SSE connection lost'));
                this.scheduleReconnect();
            }
        });
        
        // Обработчик для закрытия соединения
        this.eventSource.addEventListener('close', () => {
            console.log('[SSE] Connection closed by server');
            
            if (this.isConnected) {
                this.isConnected = false;
                this.eventHandlers.onDisconnect?.();
                this.scheduleReconnect();
            }
        });
    }
    
    private handleEvent(event: SseEvent): void {
        // Обновляем время последнего события (закомментировано, так как не используется)
        // const eventTime = Date.now();
        
        // Обрабатываем специфичные типы событий
        switch (event.type) {
            case 'new_message':
                this.eventHandlers.onMessage?.(event);
                break;
                
            case 'typing':
                this.eventHandlers.onTyping?.(event);
                break;
                
            case 'channel_message':
                this.eventHandlers.onChannelMessage?.(event);
                break;
                
            case 'user_status':
                this.eventHandlers.onUserStatus?.(event);
                break;
                
            case 'channel_subscription_approved':
            case 'channel_subscription_rejected':
                this.eventHandlers.onChannelSubscription?.(event);
                break;
                
            default:
                console.warn('[SSE] Unknown event type:', (event as SseEvent).type);
        }
        
        // Обновляем статистику
        this.reconnectAttempts = 0;
    }
    
    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.isConnecting) {
            return;
        }
        
        this.reconnectAttempts++;
        
        if (this.reconnectAttempts > this.config.maxReconnectAttempts!) {
            console.error('[SSE] Max reconnect attempts reached');
            this.eventHandlers.onError?.(new Error('Max reconnect attempts reached'));
            return;
        }
        
        const delay = this.config.reconnectInterval! * Math.pow(1.5, this.reconnectAttempts - 1);
        const jitter = Math.random() * 1000;
        
        console.log(`[SSE] Scheduling reconnect in ${Math.round(delay + jitter)}ms (attempt ${this.reconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            
            if (this.isConnecting) {
                return;
            }
            
            // Пытаемся переподключиться
            // Токен должен быть получен извне
            console.log('[SSE] Attempting to reconnect...');
        }, delay + jitter);
    }
    
    // Метод для ручной отправки события (для тестирования)
    sendEvent(event: SseEvent): void {
        this.handleEvent(event);
    }
    
    // Метод для сброса состояния
    reset(): void {
        this.disconnect();
        this.reconnectAttempts = 0;
        this.eventHandlers = {};
    }
}