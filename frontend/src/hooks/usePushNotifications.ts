import { useEffect, useRef } from "react";
import { getVapidPublicKey, subscribePush } from "../api.ts";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = atob(base64);
	return Uint8Array.from(rawData, (c) => c.charCodeAt(0));
}

export function usePushNotifications(token: string) {
	useEffect(() => {
		if (token === "") {
			return;
		}

		let cancelled = false;

		async function setup() {
			if (typeof Notification === "undefined") {
				return;
			}

			if (Notification.permission === "denied") {
				return;
			}

			if (Notification.permission === "default") {
				const permission = await Notification.requestPermission();
				if (permission !== "granted") {
					return;
				}
			}

			try {
				const registration = await navigator.serviceWorker.ready;
				const existingSub = await registration.pushManager.getSubscription();

				if (Notification.permission === "granted") {
					let endpoint: string;
					let p256dh: string;
					let auth: string;

					if (existingSub) {
						const subJSON = existingSub.toJSON();
						if (
							!subJSON.endpoint ||
							!subJSON.keys?.p256dh ||
							!subJSON.keys?.auth
						)
							return;

						endpoint = subJSON.endpoint;
						p256dh = subJSON.keys.p256dh;
						auth = subJSON.keys.auth;
					} else {
						const { publicKey } = await getVapidPublicKey();

						if (cancelled) return;

						const key = urlBase64ToUint8Array(publicKey);
						const sub = await registration.pushManager.subscribe({
							userVisibleOnly: true,
							applicationServerKey: key as unknown as BufferSource,
						});

						const subJSON = sub.toJSON();
						if (
							!subJSON.endpoint ||
							!subJSON.keys?.p256dh ||
							!subJSON.keys?.auth
						)
							return;

						endpoint = subJSON.endpoint;
						p256dh = subJSON.keys.p256dh;
						auth = subJSON.keys.auth;
					}

					await subscribePush(token, endpoint, p256dh, auth);
				}
			} catch (err) {
				console.warn("push notification setup failed", err);
			}
		}

		setup();

		return () => {
			cancelled = true;
		};
	}, [token]);

	// Only unsubscribe when the session ends (token becomes empty), not on
	// token refresh — otherwise an expiring token would tear down and
	// re-create the subscription, creating a window where pushes are lost.
	// The server-side record is left behind on purpose: it can't be
	// removed without a valid Bearer token (the DELETE endpoint is behind
	// AuthMiddleware), and the backend evicts stale subscriptions via
	// push service's onPushExpired callback.
	const didUnsubscribeRef = useRef(false);
	useEffect(() => {
		if (token !== "") {
			didUnsubscribeRef.current = false;
			return;
		}
		if (didUnsubscribeRef.current) return;
		didUnsubscribeRef.current = true;

		(async () => {
			try {
				const registration = await navigator.serviceWorker.ready;
				const subscription = await registration.pushManager.getSubscription();
				await subscription?.unsubscribe();
			} catch (err) {
				console.warn("push unsubscribe failed on cleanup", err);
			}
		})();
	}, [token]);
}
