/// <reference lib="webworker" />

import type { RouteMatchCallbackOptions } from "workbox-core";
import { cacheNames, setCacheNameDetails } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkOnly } from "workbox-strategies";
import { handleNavigation } from "./sw/navigation";
import { classifyRequest, type RouteKind } from "./sw/routing";
import { runBackgroundOutbox } from "./sync/backgroundOutbox";

declare let self: ServiceWorkerGlobalScope & {
	__WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

interface PushPayload {
	title: string;
	body: string;
	tag: string;
	data: {
		chatId: string;
		messageId: string;
		threadId?: string;
	};
}

setCacheNameDetails({
	prefix: "fast-chat",
	suffix: "v1",
});

const runtimeCacheName = cacheNames.runtime;

const manifest = self.__WB_MANIFEST;

const cacheEntries: RequestInfo[] = [];
const manifestURLs = manifest.map((entry) => {
	const url = typeof entry === "string" ? entry : entry.url;
	const fullUrl = new URL(url, self.location.href).href;
	cacheEntries.push(new Request(fullUrl, { credentials: "same-origin" }));
	return fullUrl;
});

self.addEventListener("install", (event: ExtendableEvent) => {
	event.waitUntil(
		caches.open(runtimeCacheName).then((cache) => cache.addAll(cacheEntries)),
	);
});

self.addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(
		caches.open(runtimeCacheName).then((cache) => {
			return cache.keys().then((keys) => {
				return Promise.all(
					keys
						.filter((request) => !manifestURLs.includes(request.url))
						.map((request) => cache.delete(request)),
				);
			});
		}),
	);

	void self.clients.claim();
});

// Every installed asset is cached on install, but the worker must also serve
// it: without a route the cache is only a copy nobody reads, and the app
// cannot start offline.
const matchesKind = (kind: RouteKind) => (options: RouteMatchCallbackOptions) =>
	classifyRequest(
		{
			url: options.url.href,
			method: options.request.method,
			mode: options.request.mode,
			sameOrigin: options.sameOrigin,
		},
		manifestURLs,
	) === kind;

// Authenticated API and file responses are never cached: the cache key
// is the URL without Authorization, so one account would otherwise read
// another account's bytes after logout/switch. File blobs stay in the
// per-account IndexedDB fileCache instead.
registerRoute(matchesKind("api"), new NetworkOnly());

registerRoute(
	matchesKind("precache"),
	new CacheFirst({ cacheName: runtimeCacheName }),
);

// A navigation goes to the network first so a new deployment is picked up,
// and falls back to the cached shell offline. The shell is one document for
// every client-side route, so /chat works even when it was never visited.
const shellURL = new URL("index.html", self.registration.scope).href;

registerRoute(matchesKind("navigation"), async ({ request }) => {
	const cache = await caches.open(runtimeCacheName);

	return handleNavigation({ request, shellURL, cache });
});

// Explicit cache purge for logout/account-switch. CacheStorage is shared
// with the window context (clearAllData already deletes it), this handles
// the worker side when it is the only live context.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
	const data = event.data as { type?: string } | null;
	if (data?.type !== "CLEAR_SW_CACHES") return;
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter(
							(name) =>
								name.includes("file-cache") || name.includes("api-cache"),
						)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => undefined),
	);
});

void self.skipWaiting();

self.addEventListener("push", (event: PushEvent) => {
	if (!event.data) {
		return;
	}

	let payload: PushPayload;
	try {
		payload = event.data.json() as PushPayload;
	} catch {
		return;
	}

	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag,
			data: payload.data,
			icon: "/logo192.png",
			badge: "/logo192.png",
		}),
	);
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
	event.notification.close();

	const data = event.notification.data as
		| { chatId: string; threadId?: string }
		| undefined;
	if (!data?.chatId) {
		return;
	}

	const params = new URLSearchParams({ chatId: data.chatId });
	if (data.threadId) {
		params.set("threadId", data.threadId);
	}
	const url = `/chat?${params.toString()}`;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((windowClients) => {
				const anyChatClient = windowClients.find((client) => {
					const path = new URL(client.url).pathname;
					// The chat lives on /chat, /chat/<ref> and /group/<id>;
					// an exact match misses the canonical deep links.
					return (
						path === "/chat" ||
						path.startsWith("/chat/") ||
						path.startsWith("/group/")
					);
				});

				if (anyChatClient) {
					anyChatClient.postMessage({
						type: "NAVIGATE_TO_CHAT",
						chatId: data.chatId,
						threadId: data.threadId,
					});

					return anyChatClient.focus();
				}

				return self.clients.openWindow(url);
			}),
	);
});

// Flushes the outbox. Every open window is asked first: the application owns
// the live queries and shows the result immediately. The worker still runs the
// queue itself, because a window can be frozen or unloading when the event
// fires, and a resolved Background Sync event is not replayed. The shared Web
// Lock (`fastchat-sync:<account>`) makes the worker wait for an outbox run that
// is already in progress in a tab, so the queue is never sent twice.
async function flushOutbox(): Promise<void> {
	const windows = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});

	for (const client of windows) {
		client.postMessage({ type: "FASTCHAT_SYNC" });
	}

	await runBackgroundOutbox();
}

self.addEventListener("sync", (event: Event) => {
	const syncEvent = event as ExtendableEvent & { tag?: string };
	if (syncEvent.tag !== "fastchat-outbox") return;
	syncEvent.waitUntil(flushOutbox());
});

// Installed applications also get periodic wake-ups on browsers that support
// them; the event carries no data, it only runs the same flush.
self.addEventListener("periodicsync", (event: Event) => {
	const periodicEvent = event as ExtendableEvent & { tag?: string };
	if (periodicEvent.tag !== "fastchat-outbox") return;
	periodicEvent.waitUntil(flushOutbox());
});
