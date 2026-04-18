import type { User } from '@/features/auth/types';
import type { Chat, Message } from '@/features/chat/types';
import type { Channel } from '@/features/channel/types';
import type { FileMeta } from '@/types';

// Объекты базы данных
export interface DbUser extends User {
    // Дополнительные поля для IndexedDB
    last_sync?: string;
}

export interface DbAuth {
    access_token: string;
    refresh_token: string;
    user: DbUser | null;
    expires_at?: number;
    created_at: number;
}

export interface DbChat extends Chat {
    last_sync?: string;
    hidden_at?: string;
}

export interface DbMessage extends Message {
    // Для офлайн-работы
    is_synced: boolean;
    sync_failed?: boolean;
    sync_attempts?: number;
}

export interface DbPendingMessage {
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

export interface DbChannel extends Channel {
    last_sync?: string;
    last_message_sync?: string;
}

export interface DbFileMetadata extends FileMeta {
    local_path?: string;
    is_downloaded: boolean;
    download_path?: string;
}

// Schema версии
export interface DbSchema {
    version: number;
    stores: DbStoreSchema[];
}

export interface DbStoreSchema {
    name: string;
    keyPath: string;
    indexes?: DbIndex[];
}

export interface DbIndex {
    name: string;
    keyPath: string | string[];
    unique?: boolean;
    multiEntry?: boolean;
}

// Операции
export type DbOperation = 'read' | 'write' | 'delete' | 'clear';

export interface DbTransaction {
    stores: string[];
    mode: 'readonly' | 'readwrite';
}

// Конфигурация базы данных
export interface DbConfig {
    name: string;
    version: number;
    upgradeNeeded?: (db: IDBDatabase, oldVersion: number, newVersion: number) => void;
}

// Миграции
export interface DbMigration {
    version: number;
    description: string;
    migrate: (db: IDBDatabase, transaction: IDBTransaction) => Promise<void>;
}

// Состояние базы данных
export interface DbState {
    isInitialized: boolean;
    isAvailable: boolean;
    version: number;
    error: string | null;
    lastBackup?: string;
    size?: number;
}

export type { User, Chat, Message, Channel, FileMeta };

export type PendingMessage = {
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
};