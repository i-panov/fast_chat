export interface PushSubscription {
    endpoint: string;
    p256dh: string;
    auth_secret: string;
    user_agent?: string;
}

export interface PushSubscriptionCreateRequest {
    endpoint: string;
    p256dh: string;
    auth_secret: string;
}

export interface VapidPublicKeyResponse {
    public_key: string | null;
}

export interface NotificationSettings {
    push_enabled: boolean;
    sound_enabled: boolean;
    preview_enabled: boolean;
    mute_all: boolean;
}

export interface MutedChat {
    chat_id?: string;
    channel_id?: string;
    muted_until?: string;
}

export interface NotificationState {
    settings: NotificationSettings;
    mutedChats: MutedChat[];
    subscriptions: PushSubscription[];
}