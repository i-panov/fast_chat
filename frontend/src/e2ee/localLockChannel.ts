import { KEY_TAB_ID } from "./keys.ts";

// Cross-tab channel for an explicit "lock now": auto-lock already runs in each
// tab, but a manual lock must not leave another tab of the same account
// unlocked in memory.
export const LOCAL_LOCK_CHANNEL = "fastchat-local-lock";

interface LockRequest {
	scope: string;
	tabId: string;
}

export function postLockRequest(scope: string): void {
	if (typeof BroadcastChannel === "undefined") return;
	try {
		const channel = new BroadcastChannel(LOCAL_LOCK_CHANNEL);
		channel.postMessage({ scope, tabId: KEY_TAB_ID } satisfies LockRequest);
		channel.close();
	} catch {
		// Best effort: this tab is locked by the caller either way.
	}
}

export function listenForLockRequests(
	onLock: (scope: string) => void,
): () => void {
	if (typeof BroadcastChannel === "undefined") return () => {};
	const channel = new BroadcastChannel(LOCAL_LOCK_CHANNEL);
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const data = event.data as Partial<LockRequest> | null;
		if (typeof data?.scope !== "string") return;
		if (data.tabId === KEY_TAB_ID) return;
		onLock(data.scope);
	};
	return () => channel.close();
}
