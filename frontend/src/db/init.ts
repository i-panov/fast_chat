import { type IDBPDatabase, openDB } from "idb";
import { closeBackgroundSessionDB } from "../sync/backgroundSession.ts";
import { notify } from "./notify.ts";
import { DB_NAME, DB_VERSION, type FCSchema } from "./schema.ts";

// One IndexedDB per account so chats, messages, outbox, and sync
// cursors never leak between accounts. The active account selects which
// database getDB() returns; a null key selects the pre-account database
// (login page / logged-out state).
const dbs = new Map<string, Promise<IDBPDatabase<FCSchema>>>();

// The registry survives a reload where the account database was not opened
// yet; without it, clear-all cannot find other accounts' databases on
// browsers that do not implement indexedDB.databases().
const DB_REGISTRY_KEY = "fast_chat_db_names";

let activeAccountKey: string | null = null;

function rememberDBName(name: string): void {
	if (!name.startsWith(DB_NAME)) return;
	try {
		const raw = localStorage.getItem(DB_REGISTRY_KEY);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		const names = new Set<string>(
			Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [],
		);
		names.add(name);
		localStorage.setItem(DB_REGISTRY_KEY, JSON.stringify([...names]));
	} catch {
		// Storage may be blocked; the in-session map still covers this tab.
	}
}

export function listKnownDatabases(): string[] {
	try {
		const raw = localStorage.getItem(DB_REGISTRY_KEY);
		const parsed: unknown = raw === null ? [] : JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is string =>
				typeof item === "string" &&
				(item === DB_NAME || item.startsWith(`${DB_NAME}_`)),
		);
	} catch {
		return [];
	}
}

function clearDBRegistry(): void {
	try {
		localStorage.removeItem(DB_REGISTRY_KEY);
	} catch {
		// best effort
	}
}

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

// setActiveAccountKeySilently selects the database without waking the live
// queries. AuthProvider calls it during render: child effects run before the
// provider's own effect, so the first key lookup of a page load must already
// see the account's database instead of the shared pre-account one.
export function setActiveAccountKeySilently(key: string | null): void {
	activeAccountKey = key;
}

function dbNameFor(key: string | null): string {
	return key === null ? DB_NAME : `${DB_NAME}_${key}`;
}

function openDatabase(name: string): Promise<IDBPDatabase<FCSchema>> {
	rememberDBName(name);
	let open: IDBPDatabase<FCSchema> | null = null;
	let rejectBlocked: ((error: Error) => void) | null = null;
	const blocked = new Promise<never>((_, reject) => {
		rejectBlocked = reject;
	});
	const opened = openDB<FCSchema>(name, DB_VERSION, {
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

			if (oldVersion < 4) {
				if (!db.objectStoreNames.contains("decryptedFiles")) {
					const df = db.createObjectStore("decryptedFiles", {
						keyPath: "key",
					});
					df.createIndex("cachedAt", "cachedAt");
				}
			}
		},
		// Another tab has an older schema and blocks this upgrade: the open
		// request stays pending until it closes. Surface it instead of
		// silently showing an empty app forever.
		blocked() {
			// Another tab holds an older schema open. The open request stays
			// pending forever, which used to freeze getDB() with no error.
			console.warn(`IndexedDB "${name}" is blocked by another tab`);
			rejectBlocked?.(
				new Error(`IndexedDB "${name}" is blocked by another tab`),
			);
		},
		// This tab holds a connection that blocks another tab's upgrade.
		// Close it so the new version can open; the next getDB reopens.
		blocking() {
			open?.close();
			open = null;
			dbs.delete(name);
		},
		// The browser closed the connection (e.g. storage pressure). Drop the
		// cached handle so the next request opens a fresh one.
		terminated() {
			open = null;
			dbs.delete(name);
		},
	});

	return Promise.race([opened, blocked])
		.then((db) => {
			open = db;
			return db;
		})
		.catch((error: unknown) => {
			// Drop the rejected promise so the next getDB() retries instead
			// of handing every caller the same failure forever.
			dbs.delete(name);
			throw error;
		});
}

export function getDB(): Promise<IDBPDatabase<FCSchema>> {
	return getDBFor(activeAccountKey);
}

// getDBFor pins the write to an account captured before a long operation:
// the active account can switch during awaits, and key material must never
// land in another account's database.
export function getDBFor(
	accountKey: string | null,
): Promise<IDBPDatabase<FCSchema>> {
	// "" would name a phantom `fast_chat_` database; treat "no account" the
	// same way as an explicit null.
	const name = dbNameFor(accountKey === "" ? null : accountKey);
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
// extraNames comes from the persisted registry captured before localStorage
// is cleared, so accounts opened in an earlier session are deleted even on
// browsers without indexedDB.databases().
export async function resetAllDBs(extraNames: string[] = []): Promise<void> {
	// The background-session database is not an account database, but its
	// open connection would block the delete below all the same.
	await closeBackgroundSessionDB();

	const known = new Set<string>(extraNames);

	for (const [name, p] of dbs) {
		known.add(name);
		const db = await p;
		db.close();
	}
	dbs.clear();

	try {
		const list = await (
			indexedDB as IDBFactory & {
				databases?: () => Promise<{ name?: string }[]>;
			}
		).databases?.();

		for (const entry of list ?? []) {
			if (entry.name !== undefined) known.add(entry.name);
		}
	} catch {
		// indexedDB.databases() is not available everywhere; the registry
		// and the in-session map still cover the known names.
	}

	const targets = [...known].filter(
		(name) => name === DB_NAME || name.startsWith(`${DB_NAME}_`),
	);
	await Promise.all(targets.map((name) => deleteDatabase(name)));
	clearDBRegistry();
}
