// One module owns reading and writing the session storage. The route guards
// (beforeLoad), the login redirect and the AuthProvider all need the same
// answer about "which token does this tab use": the per-tab token lives in
// sessionStorage, the shared account list in localStorage, and a logout in
// another tab only rewrites the account list — so a session token is trusted
// only while the account list still contains it.
export const ACCOUNTS_KEY = "accounts";
const ACTIVE_TOKEN_KEY = "activeToken";
const STORAGE_UNAVAILABLE = "account storage is unavailable";

export interface StoredUser {
	id: string;
	nick: string;
	avatarUrl?: string;
	// Mirrors the public profile of the account. Older stored accounts
	// predate the field, so it is optional and read as false.
	isAdmin?: boolean;
	isBot?: boolean;
}

export interface StoredAccount {
	token: string;
	user: StoredUser;
	email: string;
	expiresAt: string;
	sessionId?: string;
	deviceId?: string;
	deviceName?: string;
}

export function readAccounts(): StoredAccount[] {
	try {
		const raw = localStorage.getItem(ACCOUNTS_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is StoredAccount =>
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as StoredAccount).token === "string",
		);
	} catch {
		return [];
	}
}

export function writeAccounts(accounts: StoredAccount[]): void {
	try {
		localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	} catch {
		// Storage can be blocked (private mode) or full. The session still
		// works in this tab from React state; only persistence is lost.
		console.warn(STORAGE_UNAVAILABLE);
	}
}

export function readSessionToken(): string | null {
	try {
		return sessionStorage.getItem(ACTIVE_TOKEN_KEY);
	} catch {
		// Storage may be blocked (private mode, disabled cookies): no
		// session token is recoverable, treat as logged out.
		return null;
	}
}

export function writeActiveToken(token: string): void {
	try {
		sessionStorage.setItem(ACTIVE_TOKEN_KEY, token);
	} catch {
		console.warn(STORAGE_UNAVAILABLE);
	}
}

export function removeActiveToken(): void {
	try {
		sessionStorage.removeItem(ACTIVE_TOKEN_KEY);
	} catch {
		// storage may be blocked
	}
}

export function readLastActiveToken(): string | null {
	try {
		return localStorage.getItem(ACTIVE_TOKEN_KEY);
	} catch {
		return null;
	}
}

export function writeLastActiveToken(token: string): void {
	try {
		localStorage.setItem(ACTIVE_TOKEN_KEY, token);
	} catch {
		console.warn(STORAGE_UNAVAILABLE);
	}
}

export function removeLastActiveToken(): void {
	try {
		localStorage.removeItem(ACTIVE_TOKEN_KEY);
	} catch {
		// storage may be blocked
	}
}

// readAnyToken returns a token of any stored account or null when there is
// none left. It answers "is this tab logged in" for the login route: a token
// from a dead session must not bounce the user back to an empty chat.
export function readAnyToken(): string | null {
	const accounts = readAccounts();
	const session = readSessionToken();
	if (accounts.length === 0) {
		// A per-tab token without any stored account is a leftover of a
		// logout in another tab; it must not keep a route guard happy.
		if (session !== null) removeActiveToken();
		return null;
	}

	if (session !== null && accounts.some((a) => a.token === session)) {
		return session;
	}

	const last = readLastActiveToken();
	if (last !== null && accounts.some((a) => a.token === last)) return last;

	return accounts[0]?.token ?? null;
}

// resolveActiveToken picks the token this tab should use and persists it:
// the per-tab token first, then the last active one, then the first stored
// account. A session token of an account another tab has already removed is
// dropped instead of letting /chat render from it.
export function resolveActiveToken(
	stored: StoredAccount[] = readAccounts(),
): string | null {
	const session = readSessionToken();
	if (session !== null && stored.some((a) => a.token === session)) {
		return session;
	}
	if (session !== null) removeActiveToken();

	const last = readLastActiveToken();
	if (last !== null && stored.some((a) => a.token === last)) {
		writeActiveToken(last);
		return last;
	}

	const first = stored[0]?.token ?? null;
	if (first !== null) {
		writeActiveToken(first);
		writeLastActiveToken(first);
	}
	return first;
}

// readActiveToken is the name the route guards use: the token this tab should
// use right now, validated against the account list.
export const readActiveToken = readAnyToken;
