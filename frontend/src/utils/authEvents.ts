const UNAUTHORIZED_EVENT = "auth:unauthorized";

export function emitUnauthorized(token: string) {
	window.dispatchEvent(
		new CustomEvent(UNAUTHORIZED_EVENT, { detail: { token } }),
	);
}

export function onUnauthorized(fn: (token: string) => void) {
	const handler = (e: Event) => {
		fn((e as CustomEvent<{ token: string }>).detail.token);
	};
	window.addEventListener(UNAUTHORIZED_EVENT, handler);
	return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}
