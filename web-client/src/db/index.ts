import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
    User,
    Chat,
    Message,
    Channel,
    PendingMessage,
    FileMeta,
} from "@/types";

interface FastChatDB extends DBSchema {
    users: {
        key: string;
        value: User;
    };
    chats: {
        key: string;
        value: Chat;
        indexes: { "by-updated": string };
    };
    messages: {
        key: string;
        value: Message;
        indexes: { "by-chat": [string, string] };
    };
    channels: {
        key: string;
        value: Channel;
    };
    pending_messages: {
        key: string;
        value: PendingMessage;
        indexes: { "by-chat": string };
    };
    files: {
        key: string;
        value: { meta: FileMeta; blob: Blob };
    };
    auth: {
        key: string;
        value: {
            encrypted_access_token: string;
            encrypted_refresh_token: string;
            user: User;
            sse_connected: boolean;
        };
    };
    keys: {
        key: string;
        value: {
            publicKey: string;
            secretKey: string;
        };
    };
    csrf_token: {
        key: string;
        value: {
            token: string;
            expires: number;
        };
    };
}

const DB_NAME = "fast-chat-db";
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<FastChatDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<FastChatDB>> {
    if (!dbPromise) {
        dbPromise = openDB<FastChatDB>(DB_NAME, DB_VERSION, {
            upgrade(db, _oldVersion) {
                // Always create stores for fresh install
                if (!db.objectStoreNames.contains("users")) {
                    db.createObjectStore("users");
                }
                if (!db.objectStoreNames.contains("chats")) {
                    const store = db.createObjectStore("chats");
                    store.createIndex("by-updated", "updated_at");
                }
                if (!db.objectStoreNames.contains("messages")) {
                    const store = db.createObjectStore("messages");
                    store.createIndex("by-chat", ["chat_id", "created_at"]);
                }
                if (!db.objectStoreNames.contains("channels")) {
                    db.createObjectStore("channels");
                }
                if (!db.objectStoreNames.contains("pending_messages")) {
                    const store = db.createObjectStore("pending_messages");
                    store.createIndex("by-chat", "chat_id");
                }
                if (!db.objectStoreNames.contains("files")) {
                    db.createObjectStore("files");
                }
                if (!db.objectStoreNames.contains("auth")) {
                    db.createObjectStore("auth");
                }
                if (!db.objectStoreNames.contains("keys")) {
                    db.createObjectStore("keys");
                }
                if (!db.objectStoreNames.contains("csrf_token")) {
                    db.createObjectStore("csrf_token");
                }
            },
        });
    }
    return dbPromise;
}

// ─── Auth ───
// Tokens are encrypted with NaCl keypair (self-encryption)
export async function saveAuth(data: {
    access_token: string;
    refresh_token: string;
    user: User;
}): Promise<void> {
    const db = await getDb();
    const { CryptoService } = await import("@/crypto");
    const { getKeypair } = await import("@/crypto");

    const keypair = await getKeypair();

    if (keypair) {
        // Encrypt tokens with NaCl box (self-encryption)
        const encryptedAccessToken = CryptoService.encryptWithKeypair(
            new TextEncoder().encode(data.access_token),
            keypair
        );
        const encryptedRefreshToken = CryptoService.encryptWithKeypair(
            new TextEncoder().encode(data.refresh_token),
            keypair
        );

        await db.put("auth", {
            encrypted_access_token: encryptedAccessToken,
            encrypted_refresh_token: encryptedRefreshToken,
            user: data.user,
            sse_connected: false,
        }, "current");
    } else {
        // No keypair yet - store tokens unencrypted (will be re-encrypted on next login)
        await db.put("auth", {
            encrypted_access_token: data.access_token,
            encrypted_refresh_token: data.refresh_token,
            user: data.user,
            sse_connected: false,
        }, "current");
    }
}

export async function getAuth(): Promise<{
    access_token: string;
    refresh_token: string;
    user: User;
    sse_connected: boolean;
} | null> {
    const db = await getDb();
    const result = await db.get("auth", "current") as {
        encrypted_access_token: string;
        encrypted_refresh_token: string;
        user: User;
        sse_connected: boolean;
    } | null;

    if (!result) return null;

    // Try to decrypt with keypair, but handle case where keys don't exist yet
    try {
        const { CryptoService } = await import("@/crypto");
        const { getKeypair } = await import("@/crypto");
        const keypair = await getKeypair();

        if (keypair) {
            const accessTokenBytes = CryptoService.decryptWithKeypair(
                result.encrypted_access_token,
                keypair
            );
            const refreshTokenBytes = CryptoService.decryptWithKeypair(
                result.encrypted_refresh_token,
                keypair
            );

            return {
                access_token: new TextDecoder().decode(accessTokenBytes),
                refresh_token: new TextDecoder().decode(refreshTokenBytes),
                user: result.user,
                sse_connected: result.sse_connected
            };
        }
    } catch {
        // Keypair doesn't exist yet or decryption failed
    }

    // No keypair or decryption failed - return as-is (may be unencrypted or old format)
    return {
        access_token: result.encrypted_access_token,
        refresh_token: result.encrypted_refresh_token,
        user: result.user,
        sse_connected: result.sse_connected
    };
}

export async function clearAuth(): Promise<void> {
    const db = await getDb();
    await db.delete("auth", "current");
    await clearCsrfToken();
}

export async function updateAuthField(
    field: string,
    value: unknown,
): Promise<void> {
    const db = await getDb();
    const auth = await db.get("auth", "current");
    if (auth) {
        (auth as Record<string, unknown>)[field] = value;
        await db.put("auth", auth, "current");
    }
}

// ─── Chats ───
export async function syncChats(chats: Chat[]): Promise<void> {
    const db = await getDb();
    const existingChats = await db.getAll("chats");
    const existingIds = new Set(existingChats.map((c) => c.id));
    const serverIds = new Set(chats.map((c) => c.id));

    const tx = db.transaction("chats", "readwrite");

    for (const id of existingIds) {
        if (!serverIds.has(id)) {
            await tx.store.delete(id);
        }
    }

    for (const chat of chats) {
        const existing = existingChats.find((c) => c.id === chat.id);
        const merged = existing
            ? { ...existing, ...chat, updated_at: chat.created_at }
            : { ...chat, updated_at: chat.created_at };
        await tx.store.put(merged, chat.id);
    }
    await tx.done;
}

export async function saveChat(chat: Chat): Promise<void> {
    const db = await getDb();
    const existing = await db.get("chats", chat.id);
    const merged = { ...existing, ...chat, updated_at: chat.created_at };
    await db.put("chats", merged, merged.id);
}

export async function saveChats(chats: Chat[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("chats", "readwrite");
    for (const chat of chats) {
        const existing = await tx.store.get(chat.id);
        const merged = { ...existing, ...chat, updated_at: chat.created_at };
        await tx.store.put(merged, merged.id);
    }
    await tx.done;
}

export async function getAllChats(): Promise<Chat[]> {
    const db = await getDb();
    return db.getAllFromIndex("chats", "by-updated");
}

export async function getChat(id: string): Promise<Chat | null> {
    const db = await getDb();
    const result = await db.get("chats", id);
    return result ?? null;
}

export async function updateChatUnread(
    chatId: string,
    count: number,
): Promise<void> {
    const db = await getDb();
    const chat = await db.get("chats", chatId);
    if (chat) {
        chat.unread_count = count;
        await db.put("chats", chat, chat.id);
    }
}

export async function deleteChatLocally(chatId: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(["chats", "messages"], "readwrite");
    await tx.objectStore("chats").delete(chatId);
    const msgs = await tx.objectStore("messages").getAll();
    for (const msg of msgs) {
        if (msg.chat_id === chatId) {
            await tx.objectStore("messages").delete(msg.id);
        }
    }
    await tx.done;
}

// ─── Messages ───
export async function saveMessages(messages: Message[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("messages", "readwrite");
    for (const msg of messages) {
        const existing = await tx.store.get(msg.id);
        if (!existing?.local_pending) {
            await tx.store.put(msg, msg.id);
        }
    }
    await tx.done;
}

export async function getMessagesByChat(
    chatId: string,
    limit = 50,
    before?: string,
): Promise<Message[]> {
    const db = await getDb();
    if (before) {
        return db
            .getAllFromIndex(
                "messages",
                "by-chat",
                IDBKeyRange.bound([chatId, ""], [chatId, before], false, true),
            )
            .then((r) => r.slice(-limit));
    }
    return db
        .getAllFromIndex(
            "messages",
            "by-chat",
            IDBKeyRange.bound([chatId, ""], [chatId, "\uffff"], false, true),
        )
        .then((r) => r.slice(-limit));
}

export async function saveMessage(msg: Message): Promise<void> {
    const db = await getDb();
    const existing = await db.get("messages", msg.id);
    if (!existing?.local_pending) {
        await db.put("messages", msg, msg.id);
    }
}

// ─── Pending Messages (offline queue) ───
export async function addPendingMessage(msg: PendingMessage): Promise<void> {
    const db = await getDb();
    await db.put("pending_messages", msg, msg.id);
}

export async function getPendingMessages(): Promise<PendingMessage[]> {
    const db = await getDb();
    return db.getAll("pending_messages");
}

export async function getPendingByChat(
    chatId: string,
): Promise<PendingMessage[]> {
    const db = await getDb();
    return db.getAllFromIndex("pending_messages", "by-chat", chatId);
}

export async function removePendingMessage(id: string): Promise<void> {
    const db = await getDb();
    await db.delete("pending_messages", id);
}

export async function updatePendingRetry(
    id: string,
    retryCount: number,
    lastAttempt: number,
): Promise<void> {
    const db = await getDb();
    const msg = await db.get("pending_messages", id);
    if (msg) {
        msg.retry_count = retryCount;
        msg.last_attempt = lastAttempt;
        await db.put("pending_messages", msg, msg.id);
    }
}

// ─── Channels ───
export async function saveChannels(channels: Channel[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("channels", "readwrite");
    for (const ch of channels) {
        await tx.store.put(ch, ch.id);
    }
    await tx.done;
}

export async function syncChannels(channels: Channel[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction("channels", "readwrite");
    await tx.store.clear();
    for (const ch of channels) {
        await tx.store.put(ch, ch.id);
    }
    await tx.done;
}

export async function getAllChannels(): Promise<Channel[]> {
    const db = await getDb();
    return db.getAll("channels");
}

// ─── Files ───
export async function saveFile(
    id: string,
    meta: FileMeta,
    blob: Blob,
): Promise<void> {
    const db = await getDb();
    await db.put("files", { meta, blob }, id);
}

export async function getFile(
    id: string,
): Promise<{ meta: FileMeta; blob: Blob } | null> {
    const db = await getDb();
    const result = await db.get("files", id);
    return result ?? null;
}

export async function getFileBlob(id: string): Promise<Blob | null> {
    const db = await getDb();
    const entry = await db.get("files", id);
    return entry?.blob ?? null;
}

// ─── CSRF Token ───
export async function saveCsrfToken(data: { token: string; expires: number }): Promise<void> {
    try {
        const db = await getDb();
        await db.put("csrf_token", data, "current");
    } catch {
        // DB not ready yet
    }
}

export async function getCsrfToken(): Promise<{ token: string; expires: number } | null> {
    try {
        const db = await getDb();
        const result = await db.get("csrf_token", "current");
        return result ?? null;
    } catch {
        return null;
    }
}

export async function clearCsrfToken(): Promise<void> {
    try {
        const db = await getDb();
        await db.delete("csrf_token", "current");
    } catch {
        // DB not ready yet
    }
}