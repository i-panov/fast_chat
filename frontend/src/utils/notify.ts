const NOTIFICATION_EVENT = "app:notification";

interface Notification {
	message: string;
	type: "error" | "info";
}

export function emitNotification(
	message: string,
	type: "error" | "info" = "error",
) {
	window.dispatchEvent(
		new CustomEvent(NOTIFICATION_EVENT, { detail: { message, type } }),
	);
}

export function onNotification(fn: (n: Notification) => void) {
	const handler = (e: Event) => {
		fn((e as CustomEvent<Notification>).detail);
	};
	window.addEventListener(NOTIFICATION_EVENT, handler);
	return () => window.removeEventListener(NOTIFICATION_EVENT, handler);
}
