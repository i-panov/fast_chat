// Реэкспорт всех типов для обратной совместимости
export * from '@/shared/types';
export * from '@/features/auth/types';
export * from '@/features/chat/types';
export * from '@/features/channel/types';
// export * from '@/features/files/types'; // Удалено, так как модуль отсутствует
export * from '@/core/network/types';
export * from '@/core/crypto/types';
export * from '@/core/db/types';

// Legacy типы для обратной совместимости (будут удалены постепенно)
import type { User as NewUser, AuthResponse as NewAuthResponse } from '@/features/auth/types';
import type { Chat as NewChat, Message as NewMessage, PendingMessage as NewPendingMessage } from '@/features/chat/types';
import type { Channel as NewChannel } from '@/features/channel/types';
import type { SseEvent as NewSseEvent, SseMessageEvent as NewSseMessageEvent, SseTypingEvent as NewSseTypingEvent, SseChannelMessageEvent as NewSseChannelMessageEvent } from '@/core/network/types';

export type User = NewUser;
export type AuthResponse = NewAuthResponse;
export type Chat = NewChat;
export type Message = NewMessage;
export type PendingMessage = NewPendingMessage;
export type Channel = NewChannel;
export type SseEvent = NewSseEvent;
export type SseMessageEvent = NewSseMessageEvent;
export type SseTypingEvent = NewSseTypingEvent;
export type SseChannelMessageEvent = NewSseChannelMessageEvent;

// Определение FileMeta, так как модуль @/features/files/types отсутствует
export interface FileMetadata {
    id: string;
    original_name: string;
    stored_path: string;
    mime_type: string;
    size_bytes: number;
    uploader_id: string;
    uploaded_at: string;
    // Дополнительные поля
    width?: number;
    height?: number;
    duration?: number; // для видео/аудио
    thumbnail_url?: string;
}

export type FileMeta = FileMetadata;