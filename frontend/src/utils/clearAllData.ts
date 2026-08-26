import { resetDB } from "../db/init.ts";

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

export async function clearAllData(): Promise<void> {
	const lang = localStorage.getItem(LANGUAGE_KEY);
	localStorage.clear();
	sessionStorage.clear();
	if (lang) {
		localStorage.setItem(LANGUAGE_KEY, lang);
	}

	await Promise.race([
		Promise.allSettled([
			browserUnsubscribePush(),
			resetDB(),
			clearAllCaches(),
			unregisterServiceWorker(),
		]),
		new Promise<void>((resolve) => setTimeout(resolve, 4000)),
	]);
}
