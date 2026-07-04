/// <reference lib="webworker" />

import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { cacheNames, setCacheNameDetails } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, NetworkOnly } from "workbox-strategies";

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

	self.clients.claim();
});

registerRoute(
	({ url }) => url.pathname.startsWith("/api/files/"),
	new CacheFirst({
		cacheName: "file-cache",
		plugins: [
			new ExpirationPlugin({
				maxEntries: 200,
				maxAgeSeconds: 60 * 60 * 24 * 30,
			}),
			new CacheableResponsePlugin({ statuses: [0, 200] }),
		],
	}),
);

registerRoute(
	({ url }) =>
		url.pathname.startsWith("/api/") &&
		!url.pathname.startsWith("/api/events") &&
		!url.pathname.startsWith("/api/files/"),
	new NetworkFirst({
		cacheName: "api-cache",
		plugins: [
			new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 }),
			new CacheableResponsePlugin({ statuses: [0, 200] }),
		],
	}),
);

registerRoute(() => true, new NetworkOnly());

self.skipWaiting();

self.addEventListener("push", (event: PushEvent) => {
	if (!event.data) {
		return;
	}

	let payload: PushPayload;
	try {
		payload = event.data.json();
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
					const u = new URL(client.url);
					return u.pathname === "/chat";
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
