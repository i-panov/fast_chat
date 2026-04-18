// SSE события
export interface SseMessageEvent {
    type: 'new_message';
    chat_id: string;
    data: {
        id: string;
        chat_id: string;
        sender_id?: string;
        encrypted_content?: string;
        content_type?: string;
        file_metadata_id?: string | null;
        status?: string;
        edited?: boolean;
        deleted?: boolean;
        created_at?: string;
        edited_at?: string | null;
        topic_id?: string | null;
        thread_id?: string | null;
    };
}

export interface SseTypingEvent {
    type: 'typing';
    user_id: string;
    chat_id: string;
}

export interface SseChannelMessageEvent {
    type: 'channel_message';
    channel_id: string;
    data: {
        id: string;
        encrypted_content: string;
        content_type: string;
        created_at: string;
    };
}

export interface SseUserStatusEvent {
    type: 'user_status';
    user_id: string;
    is_online: boolean;
    last_seen?: string;
}

export interface SseChannelSubscriptionEvent {
    type: 'channel_subscription_approved' | 'channel_subscription_rejected';
    channel_id: string;
    user_id: string;
}

export type SseEvent =
    | SseMessageEvent
    | SseTypingEvent
    | SseChannelMessageEvent
    | SseUserStatusEvent
    | SseChannelSubscriptionEvent;

// Конфигурация SSE
export interface SseConfig {
    url: string;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    timeout?: number;
}

// Состояние SSE соединения
export interface SseConnectionState {
    isConnected: boolean;
    isConnecting: boolean;
    lastEventTime: number | null;
    reconnectAttempts: number;
    error: string | null;
}

// Хендлеры событий
export interface SseEventHandlers {
    onMessage?: (event: SseMessageEvent) => void;
    onTyping?: (event: SseTypingEvent) => void;
    onChannelMessage?: (event: SseChannelMessageEvent) => void;
    onUserStatus?: (event: SseUserStatusEvent) => void;
    onChannelSubscription?: (event: SseChannelSubscriptionEvent) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;
}

// Network state
export interface NetworkState {
    isOnline: boolean;
    lastOnlineCheck: number;
    connectionType?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
    effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
    downlink?: number;
    rtt?: number;
}

// Network Information API (Chrome only)
export interface NetworkInformation {
    effectiveType: 'slow-2g' | '2g' | '3g' | '4g';
    downlink?: number;
    rtt?: number;
    type?: 'wifi' | 'cellular' | 'ethernet' | 'unknown' | 'bluetooth' | 'wimax';
    saveData?: boolean;
    addEventListener?: (type: 'change', listener: () => void) => void;
    removeEventListener?: (type: 'change', listener: () => void) => void;
}

declare global {
    interface Navigator {
        connection?: NetworkInformation;
    }
}