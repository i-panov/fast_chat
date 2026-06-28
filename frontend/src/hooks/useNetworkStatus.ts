import { useEffect, useSyncExternalStore } from "react";

function subscribe(cb: () => void): () => void {
	window.addEventListener("online", cb);
	window.addEventListener("offline", cb);
	return () => {
		window.removeEventListener("online", cb);
		window.removeEventListener("offline", cb);
	};
}

export function useNetworkStatus(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => navigator.onLine,
		() => true,
	);
}

export function useOnlineNotifications(onBackOnline: () => void): void {
	useEffect(() => {
		const handler = () => {
			if (navigator.onLine) onBackOnline();
		};
		window.addEventListener("online", handler);
		return () => window.removeEventListener("online", handler);
	}, [onBackOnline]);
}
