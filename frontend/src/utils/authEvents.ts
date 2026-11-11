const UNAUTHORIZED_EVENT = "auth:unauthorized";

// A token rotation can race an in-flight request: the request still carries
// the old bearer while another tab has already stored the new one. The API
// layer consults this map before deciding that the session is dead.
const replacements = new Map<string, string>();
const MAX_REPLACEMENTS = 100;

export function registerTokenReplacement(oldToken: string, newToken: string) {
	if (oldToken === newToken) return;
	replacements.set(oldToken, newToken);
	while (replacements.size > MAX_REPLACEMENTS) {
		const oldest = replacements.keys().next().value;
		if (oldest === undefined) break;
		replacements.delete(oldest);
	}
}

export function replacementToken(token: string): string | undefined {
	return replacements.get(token);
}

export function forgetTokenReplacement(token: string) {
	replacements.delete(token);
}

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
