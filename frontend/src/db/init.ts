import { type IDBPDatabase, openDB } from "idb";
import { notify } from "./notify.ts";
import { DB_NAME, DB_VERSION, type FCSchema } from "./schema.ts";

// One IndexedDB per account so chats, messages, outbox, and sync
// cursors never leak between accounts. The active account selects which
// database getDB() returns; a null key selects the pre-account database
// (login page / logged-out state).
const dbs = new Map<string, Promise<IDBPDatabase<FCSchema>>>();

let activeAccountKey: string | null = null;

export function getActiveAccountKey(): string | null {
	return activeAccountKey;
}

// Switch the cache to the given account's IndexedDB and wake up live
// queries so they re-read from the new database. A null key selects the
// pre-account database (login page / logged-out state).
export function setActiveAccountKey(key: string | null): void {
	if (activeAccountKey === key) return;
	activeAccountKey = key;
	notify();
}

function dbNameFor(key: string | null): string {
	return key === null ? DB_NAME : `${DB_NAME}_${key}`;
}

function openDatabase(name: string): Promise<IDBPDatabase<FCSchema>> {
	return openDB<FCSchema>(name, DB_VERSION, {
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

export function getDB(): Promise<IDBPDatabase<FCSchema>> {
	const name = dbNameFor(activeAccountKey);
	let db = dbs.get(name);
	if (db === undefined) {
		db = openDatabase(name);
		dbs.set(name, db);
	}
	return db;
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () =>
			reject(req.error ?? new Error("indexedDB.deleteDatabase failed"));
		req.onblocked = () => resolve();
	});
}

// closeAndDeleteAccountDB closes this tab's cached connection (if any)
// and deletes one account's IndexedDB. The close must come first:
// deleteDatabase on an open connection stalls in onblocked, and the
// account's history plus its private E2E key would survive logout.
// A block by another tab's open connection still resolves best-effort
// (the delete proceeds once that tab closes its handle).
export async function closeAndDeleteAccountDB(userId: string): Promise<void> {
	const name = dbNameFor(userId);
	const cached = dbs.get(name);
	dbs.delete(name);
	if (cached !== undefined) {
		try {
			(await cached).close();
		} catch {
			// A failed open cannot block the delete.
		}
	}
	await deleteDatabase(name);
}

// Close and delete every account's IndexedDB (used by "clear all data").
export async function resetAllDBs(): Promise<void> {
	const names: string[] = [];

	for (const [name, p] of dbs) {
		names.push(name);
		const db = await p;
		db.close();
	}
	dbs.clear();

	let targets: string[] = names;

	try {
		const list = await (
			indexedDB as IDBFactory & {
				databases?: () => Promise<{ name?: string }[]>;
			}
		).databases?.();

		if (list !== undefined) {
			targets = list
				.map((d) => d.name)
				.filter(
					(n): n is string =>
						n !== undefined && (n === DB_NAME || n.startsWith(`${DB_NAME}_`)),
				);
		}
	} catch {
		// indexedDB.databases() is not available everywhere; fall back to
		// the databases opened this session.
	}

	await Promise.all(targets.map((n) => deleteDatabase(n)));
}
