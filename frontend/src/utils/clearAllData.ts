import { revokeSession } from "../api.ts";
import {
	closeAndDeleteAccountDB,
	listKnownDatabases,
	resetAllDBs,
	setActiveAccountKey,
} from "../db/init.ts";
import { DB_NAME } from "../db/schema.ts";
import { LANGUAGE_PREFERENCE_KEY } from "../languagePreference.ts";
import { deleteBackgroundSessionDB } from "../sync/backgroundSession.ts";
import { setTokenProvider } from "../sync/syncEngine.ts";
import { readActiveToken } from "./activeToken.ts";
import { clearFileCache } from "./fileCache.ts";

async function browserUnsubscribePush(): Promise<void> {
	try {
		const registration = await navigator.serviceWorker.ready;
		const subscription = await registration.pushManager.getSubscription();
		if (!subscription) return;
		await subscription.unsubscribe();
	} catch {
		// best effort
	}
}

async function clearCacheStorage(): Promise<void> {
	try {
		const names = await caches.keys();
		await Promise.all(names.map((name) => caches.delete(name)));
	} catch {
		// best effort
	}
}

async function clearAllCaches(): Promise<void> {
	try {
		// Service worker caches plus the runtime cache used by the
		// app shell — ensures no private API responses survive logout.
		await clearCacheStorage();
		if ("caches" in window) {
			await caches
				.keys()
				.then((names) => Promise.all(names.map((name) => caches.delete(name))));
		}
	} catch {
		// best effort
	}
}

function notifyServiceWorkerCaches(): void {
	try {
		if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
			navigator.serviceWorker.controller.postMessage({
				type: "CLEAR_SW_CACHES",
			});
		}
	} catch {
		// best effort
	}
}

async function unregisterServiceWorker(): Promise<void> {
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		if (registration) {
			await registration.unregister();
		}
	} catch {
		// best effort
	}
}

// deleteAccountDB removes a single account's IndexedDB (logout of one
// account must not wipe the others). The cached connection is closed
// first via closeAndDeleteAccountDB: without the close the delete stalls
// in onblocked and the data survives.
export async function deleteAccountDB(userId: string): Promise<void> {
	try {
		await closeAndDeleteAccountDB(userId);
	} catch {
		// best effort
	}
}

// clearAccountSwitchState drops in-memory per-account state without
// wiping storage: used on account switch where the other account's IDB
// must stay intact.
export function clearAccountSwitchState(): void {
	clearFileCache();
	notifyServiceWorkerCaches();
}

export interface ClearAllDataResult {
	ok: boolean;
	// Databases the browser still reports after the wipe. Non-empty means the
	// delete was blocked (another tab holds the database open) and the
	// account history or its E2EE key may still be on disk.
	remainingDatabases: string[];
}

async function listRemainingDatabases(): Promise<string[]> {
	try {
		const list = await (
			indexedDB as IDBFactory & {
				databases?: () => Promise<{ name?: string }[]>;
			}
		).databases?.();
		return (list ?? [])
			.map((entry) => entry.name)
			.filter(
				(name): name is string =>
					typeof name === "string" &&
					(name === DB_NAME || name.startsWith(`${DB_NAME}_`)),
			);
	} catch {
		return [];
	}
}

export async function clearAllData(): Promise<ClearAllDataResult> {
	// Capture the registry before localStorage is wiped: it is the only way
	// to find account databases that were opened in an earlier session on a
	// browser without indexedDB.databases().
	const knownDBs = listKnownDatabases();
	// The language choice is a device preference, not account data: clearing
	// the app must not silently switch the interface.
	const language = localStorage.getItem(LANGUAGE_PREFERENCE_KEY);
	// Revoke the server session before its token is erased: a token that only
	// disappears from this browser stays usable until it expires.
	const token = readActiveToken();

	// Stop any in-flight sync before deleting: a tick that starts after the
	// reset would recreate the database and refill it with downloaded history.
	setTokenProvider(() => null);
	setActiveAccountKey(null);
	clearFileCache();
	notifyServiceWorkerCaches();
	localStorage.clear();
	sessionStorage.clear();
	if (language !== null)
		localStorage.setItem(LANGUAGE_PREFERENCE_KEY, language);

	await Promise.race([
		(async () => {
			// The mirrored background credentials are not an account database:
			// remove them explicitly, before the account databases so the two
			// deletes do not race.
			await deleteBackgroundSessionDB();
			await Promise.allSettled([
				token === null ? Promise.resolve() : revokeSession(token),
				browserUnsubscribePush(),
				resetAllDBs(knownDBs),
				clearAllCaches(),
				unregisterServiceWorker(),
			]);
		})(),
		new Promise<void>((resolve) => setTimeout(resolve, 4000)),
	]);

	const remainingDatabases = await listRemainingDatabases();
	return { ok: remainingDatabases.length === 0, remainingDatabases };
}
