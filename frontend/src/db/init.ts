import { type IDBPDatabase, openDB } from "idb";
import { DB_NAME, DB_VERSION, type FCSchema } from "./schema.ts";

let dbPromise: Promise<IDBPDatabase<FCSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<FCSchema>> {
	if (dbPromise === null) {
		dbPromise = openDB<FCSchema>(DB_NAME, DB_VERSION, {
			upgrade(db) {
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
			},
		});
	}

	return dbPromise;
}
