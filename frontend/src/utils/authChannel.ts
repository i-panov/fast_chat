const AUTH_CHANNEL = "fastchat-auth";

export interface TokenRotationMessage {
	type: "token-rotated";
	userId: string;
	oldToken: string;
	token: string;
	expiresAt: string;
}

// BroadcastChannel is supported by the browsers this app targets. The guard
// keeps tests and very old webviews working: storage events still propagate
// the token, just without the instant same-origin notification.
export function broadcastTokenRotation(message: TokenRotationMessage) {
	if (typeof BroadcastChannel === "undefined") return;

	const channel = new BroadcastChannel(AUTH_CHANNEL);
	try {
		channel.postMessage(message);
	} finally {
		channel.close();
	}
}

export function onTokenRotation(
	fn: (message: TokenRotationMessage) => void,
): () => void {
	if (typeof BroadcastChannel === "undefined") return () => {};

	const channel = new BroadcastChannel(AUTH_CHANNEL);
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const data = event.data;
		if (
			typeof data === "object" &&
			data !== null &&
			(data as { type?: unknown }).type === "token-rotated"
		) {
			fn(data as TokenRotationMessage);
		}
	};

	return () => {
		channel.onmessage = null;
		channel.close();
	};
}
