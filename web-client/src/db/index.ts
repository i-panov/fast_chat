import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { User, Chat, Message, Channel, PendingMessage, FileMeta } from '@/types'

interface FastChatDB extends DBSchema {
  users: {
    key: string
    value: User
  }
  chats: {
    key: string
    value: Chat
    indexes: { 'by-updated': string }
  }
  messages: {
    key: string
    value: Message
    indexes: { 'by-chat': [string, string] }
  }
  channels: {
    key: string
    value: Channel
  }
  pending_messages: {
    key: string
    value: PendingMessage
    indexes: { 'by-chat': string }
  }
  files: {
    key: string
    value: { meta: FileMeta; blob: Blob }
  }
  auth: {
    key: string
    value: { access_token: string; refresh_token: string; user: User; sse_connected: boolean }
  }
}

const DB_NAME = 'fast-chat-db'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<FastChatDB>> | null = null

export function getDb(): Promise<IDBPDatabase<FastChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FastChatDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Users — single record keyed by 'current'
        if (!db.objectStoreNames.contains('users')) {
          db.createObjectStore('users')
        }

        // Chats
        if (!db.objectStoreNames.contains('chats')) {
          const store = db.createObjectStore('chats')
          store.createIndex('by-updated', 'updated_at')
        }

        // Messages — composite index for chat+time ordering
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages')
          store.createIndex('by-chat', ['chat_id', 'created_at'])
        }

        // Channels
        if (!db.objectStoreNames.contains('channels')) {
          db.createObjectStore('channels')
        }

        // Pending messages (offline queue)
        if (!db.objectStoreNames.contains('pending_messages')) {
          const store = db.createObjectStore('pending_messages')
          store.createIndex('by-chat', 'chat_id')
        }

        // Files (blob storage for offline viewing)
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files')
        }

        // Auth state
        if (!db.objectStoreNames.contains('auth')) {
          db.createObjectStore('auth')
        }
      },
    })
  }
  return dbPromise
}

// ─── Auth ───
export async function saveAuth(data: { access_token: string; refresh_token: string; user: User }): Promise<void> {
  const db = await getDb()
  await db.put('auth', { ...data, sse_connected: false }, 'current')
}

export async function getAuth(): Promise<{ access_token: string; refresh_token: string; user: User; sse_connected: boolean } | null> {
  const db = await getDb()
  return db.get('auth', 'current') ?? null
}

export async function clearAuth(): Promise<void> {
  const db = await getDb()
  await db.delete('auth', 'current')
}

export async function updateAuthField(field: string, value: unknown): Promise<void> {
  const db = await getDb()
  const auth = await db.get('auth', 'current')
  if (auth) {
    (auth as Record<string, unknown>)[field] = value
    await db.put('auth', auth, 'current')
  }
}

// ─── Chats ───
export async function saveChat(chat: Chat): Promise<void> {
  const db = await getDb()
  const existing = await db.get('chats', chat.id)
  const merged = { ...existing, ...chat, updated_at: chat.created_at }
  await db.put('chats', merged)
}

export async function saveChats(chats: Chat[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('chats', 'readwrite')
  for (const chat of chats) {
    const existing = await tx.store.get(chat.id)
    const merged = { ...existing, ...chat, updated_at: chat.created_at }
    await tx.store.put(merged)
  }
  await tx.done
}

export async function getAllChats(): Promise<Chat[]> {
  const db = await getDb()
  return db.getAllFromIndex('chats', 'by-updated')
}

export async function getChat(id: string): Promise<Chat | null> {
  const db = await getDb()
  return db.get('chats', id) ?? null
}

export async function updateChatUnread(chatId: string, count: number): Promise<void> {
  const db = await getDb()
  const chat = await db.get('chats', chatId)
  if (chat) {
    chat.unread_count = count
    await db.put('chats', chat)
  }
}

// ─── Messages ───
export async function saveMessages(messages: Message[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('messages', 'readwrite')
  for (const msg of messages) {
    const existing = await tx.store.get(msg.id)
    // Don't overwrite local_pending messages with server response
    if (!existing?.local_pending) {
      await tx.store.put(msg)
    }
  }
  await tx.done
}

export async function getMessagesByChat(chatId: string, limit = 50, before?: string): Promise<Message[]> {
  const db = await getDb()
  if (before) {
    return db.getAllFromIndex('messages', 'by-chat', IDBKeyRange.bound([chatId, ''], [chatId, before], false, true)).then(r => r.slice(-limit))
  }
  return db.getAllFromIndex('messages', 'by-chat', IDBKeyRange.bound([chatId, ''], [chatId, '\uffff'], false, true)).then(r => r.slice(-limit))
}

export async function saveMessage(msg: Message): Promise<void> {
  const db = await getDb()
  const existing = await db.get('messages', msg.id)
  if (!existing?.local_pending) {
    await db.put('messages', msg)
  }
}

// ─── Pending Messages (offline queue) ───
export async function addPendingMessage(msg: PendingMessage): Promise<void> {
  const db = await getDb()
  await db.put('pending_messages', msg)
}

export async function getPendingMessages(): Promise<PendingMessage[]> {
  const db = await getDb()
  return db.getAll('pending_messages')
}

export async function getPendingByChat(chatId: string): Promise<PendingMessage[]> {
  const db = await getDb()
  return db.getAllFromIndex('pending_messages', 'by-chat', chatId)
}

export async function removePendingMessage(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('pending_messages', id)
}

export async function updatePendingRetry(id: string, retryCount: number, lastAttempt: number): Promise<void> {
  const db = await getDb()
  const msg = await db.get('pending_messages', id)
  if (msg) {
    msg.retry_count = retryCount
    msg.last_attempt = lastAttempt
    await db.put('pending_messages', msg)
  }
}

// ─── Channels ───
export async function saveChannels(channels: Channel[]): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('channels', 'readwrite')
  for (const ch of channels) {
    await tx.store.put(ch)
  }
  await tx.done
}

export async function getAllChannels(): Promise<Channel[]> {
  const db = await getDb()
  return db.getAll('channels')
}

// ─── Files ───
export async function saveFile(id: string, meta: FileMeta, blob: Blob): Promise<void> {
  const db = await getDb()
  await db.put('files', { meta, blob }, id)
}

export async function getFile(id: string): Promise<{ meta: FileMeta; blob: Blob } | null> {
  const db = await getDb()
  return db.get('files', id) ?? null
}

export async function getFileBlob(id: string): Promise<Blob | null> {
  const db = await getDb()
  const entry = await db.get('files', id)
  return entry?.blob ?? null
}
