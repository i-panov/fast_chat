import { resetAllDBs } from "../db/init.ts";
import { clearFileCache } from "./fileCache.ts";

const LANGUAGE_KEY = "i18nextLng";

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
		const { closeAndDeleteAccountDB } = await import("../db/init.ts");
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

export async function clearAllData(): Promise<void> {
	const lang = localStorage.getItem(LANGUAGE_KEY);
	clearFileCache();
	notifyServiceWorkerCaches();
	localStorage.clear();
	sessionStorage.clear();
	if (lang) {
		localStorage.setItem(LANGUAGE_KEY, lang);
	}

	await Promise.race([
		Promise.allSettled([
			browserUnsubscribePush(),
			resetAllDBs(),
			clearAllCaches(),
			unregisterServiceWorker(),
		]),
		new Promise<void>((resolve) => setTimeout(resolve, 4000)),
	]);
}
