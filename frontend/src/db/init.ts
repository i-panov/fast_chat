import { type IDBPDatabase, openDB } from "idb";
import { DB_NAME, DB_VERSION, type FCSchema } from "./schema.ts";

let dbPromise: Promise<IDBPDatabase<FCSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<FCSchema>> {
	if (dbPromise === null) {
		dbPromise = openDB<FCSchema>(DB_NAME, DB_VERSION, {
			upgrade(db, oldVersion) {
				if (!db.objectStoreNames.contains("chats")) {
					const chats = db.createObjectStore("chats", { keyPath: "id" });
					chats.createIndex("_updatedAt", "_updatedAt");
				}

				if (!db.objectStoreNames.contains("messages")) {
					const messages = db.createObjectStore("messages", {
						keyPath: "id",
					});
					messages.createIndex("chatId", "chatId");
					messages.createIndex("_updatedAt", "_updatedAt");
					messages.createIndex("status", "status");
				}

				if (!db.objectStoreNames.contains("outbox")) {
					const outbox = db.createObjectStore("outbox", { keyPath: "opId" });
					outbox.createIndex("createdAt", "createdAt");
				}

				if (!db.objectStoreNames.contains("pendingBlobs")) {
					db.createObjectStore("pendingBlobs", { keyPath: "id" });
				}

				if (!db.objectStoreNames.contains("meta")) {
					db.createObjectStore("meta", { keyPath: "key" });
				}

				if (oldVersion < 2) {
					if (!db.objectStoreNames.contains("threads")) {
						const threads = db.createObjectStore("threads", { keyPath: "id" });
						threads.createIndex("chatId", "chatId");
						threads.createIndex("_updatedAt", "_updatedAt");
					}

					if (!db.objectStoreNames.contains("threadMessages")) {
						const tm = db.createObjectStore("threadMessages", {
							keyPath: "id",
						});
						tm.createIndex("threadId", "threadId");
						tm.createIndex("chatId", "chatId");
						tm.createIndex("_updatedAt", "_updatedAt");
					}

					if (!db.objectStoreNames.contains("fileCache")) {
						const fc = db.createObjectStore("fileCache", { keyPath: "url" });
						fc.createIndex("cachedAt", "cachedAt");
					}
				}
			},
		});
	}

	return dbPromise;
}
