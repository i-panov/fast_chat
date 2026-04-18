import type { Timestamped, WithId } from '@/shared/types';
import type { User } from '@/features/auth/types';
import type { FileMetadata } from '@/types';

export interface Chat extends WithId, Timestamped {
    is_group: boolean;
    name: string | null;
    created_by: string;
    is_favorites: boolean;
    participants: string[];
    participants_details?: User[]; // Детали участников (опционально)
    unread_count?: number;
    last_message?: Message;
    hidden?: boolean; // Скрыт для текущего пользователя
}

export interface Message extends WithId, Timestamped {
    chat_id: string;
    sender_id: string;
    sender?: User; // Детали отправителя (опционально)
    encrypted_content: string;
    content_type: string;
    file_metadata_id: string | null;
    file_metadata?: FileMetadata; // Детали файла (опционально)
    status: MessageStatus;
    edited: boolean;
    deleted: boolean;
    edited_at: string | null;
    topic_id: string | null;
    thread_id: string | null;
    // Локальные поля (не с сервера)
    local_pending?: boolean;
    local_failed?: boolean;
    local_error?: string;
    is_decrypted?: boolean; // Было ли сообщение расшифровано
}

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'sending' | 'pending';

export interface Topic extends WithId, Timestamped {
    chat_id: string;
    name: string;
    created_by: string;
    message_count?: number;
}

export interface Thread extends WithId, Timestamped {
    chat_id: string;
    root_message_id: string;
    root_message?: Message;
    reply_count: number;
    last_reply_at?: string;
}

export interface PinnedMessage extends WithId, Timestamped {
    message_id: string;
    user_id: string;
    chat_id: string;
    message?: Message;
}

export interface ChatCreateRequest {
    participant_ids: string[];
    name?: string;
    is_group?: boolean;
}

export interface MessageSendRequest {
    chat_id: string;
    content: string;
    content_type?: string;
    file_metadata_id?: string;
    topic_id?: string;
    thread_id?: string;
    encrypted_content?: string; // Для E2E-шифрования
}

export interface MessageUpdateRequest {
    content?: string;
    encrypted_content?: string;
}

export interface TypingIndicatorRequest {
    chat_id: string;
}

export interface MarkReadRequest {
    chat_id: string;
    message_id?: string;
}

export interface UnreadCount {
    chat_id: string;
    count: number;
    last_message_at: string;
}

export interface PendingMessage {
    id: string;
    chat_id: string;
    encrypted_content: string;
    content_type: string;
    file_metadata_id: string | null;
    topic_id: string | null;
    thread_id: string | null;
    created_at: string;
    retry_count: number;
    last_attempt: number;
    error?: string;
}

// Store типы
export interface ChatState {
    chats: Chat[];
    messages: Map<string, Message[]>; // chatId -> messages
    activeChatId: string | null;
    typingUsers: Map<string, Set<string>>; // chatId -> Set<userId>
    isLoading: boolean;
    error: string | null;
    publicKeysCache: Map<string, Map<string, Uint8Array>>; // chatId -> userId -> publicKey
}

export interface ChatFilters {
    search?: string;
    show_hidden?: boolean;
    favorites_only?: boolean;
    unread_only?: boolean;
}