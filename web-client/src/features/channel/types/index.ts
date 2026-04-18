import type { Timestamped, WithId } from '@/shared/types';
import type { User } from '@/features/auth/types';
import type { Message } from '@/features/chat/types';

export type ChannelAccessLevel = 'public' | 'private' | 'private_with_approval';

export interface Channel extends WithId, Timestamped {
    owner_id: string;
    owner?: User; // Детали владельца (опционально)
    title: string;
    description: string | null;
    username: string | null;
    access_level: ChannelAccessLevel;
    avatar_url: string | null;
    subscribers_count: number;
    is_subscriber: boolean;
    is_active: boolean;
    last_message?: Message;
    unread_count?: number;
}

export interface ChannelSubscriber extends WithId {
    channel_id: string;
    user_id: string;
    user?: User;
    status: ChannelSubscriptionStatus;
    joined_at: string;
}

export type ChannelSubscriptionStatus = 'active' | 'pending' | 'banned';

export interface ChannelCreateRequest {
    title: string;
    description?: string;
    username?: string;
    access_level?: ChannelAccessLevel;
    avatar_url?: string;
}

export interface ChannelUpdateRequest {
    title?: string;
    description?: string;
    username?: string;
    access_level?: ChannelAccessLevel;
    avatar_url?: string;
    is_active?: boolean;
}

export interface ChannelSubscribeRequest {
    channel_id: string;
}

export interface ChannelMessageSendRequest {
    channel_id: string;
    content: string;
    content_type?: string;
    encrypted_content?: string;
}

export interface ChannelSearchParams {
    query?: string;
    access_level?: ChannelAccessLevel;
    limit?: number;
    offset?: number;
}

// Store типы
export interface ChannelState {
    channels: Channel[];
    subscriptions: Map<string, ChannelSubscriber[]>; // channelId -> subscribers
    messages: Map<string, Message[]>; // channelId -> messages
    activeChannelId: string | null;
    isLoading: boolean;
    error: string | null;
    searchResults: Channel[];
}

export interface ChannelFilters {
    query?: string;
    access_level?: ChannelAccessLevel;
    subscribed_only?: boolean;
    active_only?: boolean;
}