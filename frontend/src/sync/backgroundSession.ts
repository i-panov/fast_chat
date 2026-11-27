import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { DB_NAME } from "../db/schema.ts";

// The Service Worker cannot read localStorage, where the application keeps
// the session, so the active token is mirrored into IndexedDB for the
// background outbox. It is the same trust boundary as localStorage: a script
// running on the origin can read both. Only a token of the active account is
// stored, and logout removes it.
const BACKGROUND_DB_NAME = `${DB_NAME}_background_session`;
const BACKGROUND_DB_VERSION = 1;
const SESSION_STORE = "session";
const ACTIVE_KEY = "active";

export interface BackgroundSession {
	token: string;
	accountKey: string;
}

interface BackgroundSchema extends DBSchema {
	session: { key: string; value: BackgroundSession };
}

let dbPromise: Promise<IDBPDatabase<BackgroundSchema>> | null = null;

function backgroundDB(): Promise<IDBPDatabase<BackgroundSchema>> {
	if (dbPromise === null) {
		dbPromise = openDB<BackgroundSchema>(
			BACKGROUND_DB_NAME,
			BACKGROUND_DB_VERSION,
			{
				upgrade(db) {
					if (!db.objectStoreNames.contains(SESSION_STORE)) {
						db.createObjectStore(SESSION_STORE);
					}
				},
			},
		);
	}

	return dbPromise;
}

export async function setBackgroundSession(
	session: BackgroundSession,
): Promise<void> {
	try {
		const db = await backgroundDB();
		await db.put(SESSION_STORE, session, ACTIVE_KEY);
	} catch {
		// Storage can be blocked (private mode, quota): the background flush
		// is best-effort and the open window still processes the outbox.
	}
}

export async function clearBackgroundSession(): Promise<void> {
	try {
		const db = await backgroundDB();
		await db.delete(SESSION_STORE, ACTIVE_KEY);
	} catch {
		// Nothing to clear when the storage is unavailable.
	}
}

export async function readBackgroundSession(): Promise<BackgroundSession | null> {
	try {
		const db = await backgroundDB();
		return (await db.get(SESSION_STORE, ACTIVE_KEY)) ?? null;
	} catch {
		return null;
	}
}

// resetAllDBs closes the account databases before deleting them; an open
// connection here would block the delete of this database the same way.
export async function closeBackgroundSessionDB(): Promise<void> {
	const pending = dbPromise;
	dbPromise = null;
	if (pending === null) return;

	try {
		(await pending).close();
	} catch {
		// A failed open has nothing to close.
	}
}

// deleteBackgroundSessionDB removes the mirrored credentials database
// explicitly. "Clear all data" already deletes every `${DB_NAME}_*` database
// when the browser supports indexedDB.databases(), but older ones do not list
// them, and a surviving background token would outlive the wipe.
// The promise resolves false when the database could not be removed (blocked
// by another tab, storage unavailable), so the caller can report the truth.
export async function deleteBackgroundSessionDB(): Promise<boolean> {
	await closeBackgroundSessionDB();

	return new Promise<boolean>((resolve) => {
		try {
			const request = indexedDB.deleteDatabase(BACKGROUND_DB_NAME);
			request.onsuccess = () => resolve(true);
			request.onerror = () => resolve(false);
			request.onblocked = () => resolve(false);
		} catch {
			resolve(false);
		}
	});
}
