import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { revokeSession } from "./api.ts";
import { setActiveAccountKey } from "./db/init.ts";
import { getRouter } from "./router.tsx";
import { onUnauthorized } from "./utils/authEvents.ts";
import {
	clearAccountSwitchState,
	deleteAccountDB,
} from "./utils/clearAllData.ts";

interface StoredUser {
	id: string;
	nick: string;
}

interface StoredAccount {
	token: string;
	user: StoredUser;
	email: string;
	expiresAt: string;
}

interface AuthContextValue {
	accounts: StoredAccount[];
	activeAccount: StoredAccount | null;
	switchAccount: (token: string) => void;
	addAccount: (
		token: string,
		user: StoredUser,
		email: string,
		expiresAt: string,
	) => void;
	removeAccount: (token: string) => void;
	updateAccountToken: (
		oldToken: string,
		newToken: string,
		newExpiresAt: string,
	) => void;
	logout: () => void;
}

const ACCOUNTS_KEY = "accounts";
const ACTIVE_TOKEN_KEY = "activeToken";

// Security note: account tokens are kept in localStorage in plaintext, so
// any XSS in this origin can steal every stored session. This is accepted
// as a trade-off for multi-account persistence without a backend session
// broker. Mitigations in place: short-lived tokens with refresh
// (updateAccountToken), dropping the token on first 401 (onUnauthorized),
// and scrubbing every reference on remove/logout. Do not add more secrets
// to these keys, and keep the XSS surface (dangerouslySetInnerHTML,
// untrusted URLs) minimal.

function mergeAccounts(
	current: StoredAccount[],
	incoming: StoredAccount[],
): StoredAccount[] {
	// Union by user id for concurrent multi-tab writes: the token is a
	// rotating field, not an identity — merging by token would resurrect a
	// stale entry as a ghost duplicate after updateAccountToken rotates
	// t1->t2 in another tab (incoming=[t2], prev=[t1]). Incoming wins on
	// field conflicts (fresher refresh).
	const byUser = new Map(current.map((a) => [a.user.id, a] as const));
	for (const a of incoming) byUser.set(a.user.id, a);
	return [...byUser.values()];
}

function readAccounts(): StoredAccount[] {
	try {
		return JSON.parse(
			localStorage.getItem(ACCOUNTS_KEY) ?? "[]",
		) as StoredAccount[];
	} catch {
		return [];
	}
}

function writeAccounts(accounts: StoredAccount[]) {
	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function readActiveToken(): string | null {
	try {
		return sessionStorage.getItem(ACTIVE_TOKEN_KEY);
	} catch {
		// Storage may be blocked (private mode, disabled cookies): no
		// session token is recoverable, treat as logged out.
		return null;
	}
}

function writeActiveToken(token: string) {
	sessionStorage.setItem(ACTIVE_TOKEN_KEY, token);
}

function removeActiveToken() {
	sessionStorage.removeItem(ACTIVE_TOKEN_KEY);
}

function readLastActiveToken(): string | null {
	return localStorage.getItem(ACTIVE_TOKEN_KEY);
}

function writeLastActiveToken(token: string) {
	localStorage.setItem(ACTIVE_TOKEN_KEY, token);
}

function removeLastActiveToken() {
	localStorage.removeItem(ACTIVE_TOKEN_KEY);
}

function resolveActiveToken(stored: StoredAccount[]): string | null {
	const session = readActiveToken();
	if (session !== null && stored.some((a) => a.token === session)) {
		return session;
	}

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

const AuthContext = createContext<AuthContextValue | null>(null);

function useAuthState() {
	const [accounts, setAccounts] = useState<StoredAccount[]>(readAccounts);
	const [activeToken, setActiveToken] = useState<string | null>(() =>
		resolveActiveToken(accounts),
	);
	// Restore the active token when the account list changes and no token
	// is currently active (e.g. accounts arrived from another tab).
	const [prevAccounts, setPrevAccounts] = useState(accounts);
	if (accounts !== prevAccounts) {
		setPrevAccounts(accounts);
		if (activeToken === null) {
			const resolved = resolveActiveToken(accounts);
			if (resolved !== null) setActiveToken(resolved);
		}
	}

	useEffect(() => {
		function handleStorage(e: StorageEvent) {
			if (e.key === ACCOUNTS_KEY) {
				const incoming = readAccounts();
				setAccounts((prev) => {
					// A pure removal (incoming ⊆ prev) replaces the state so
					// a logged-out session is not resurrected; otherwise
					// union by user id so a concurrent add is not lost.
					// Identity is the user id (see mergeAccounts): token
					// rotation must not look like a new account.
					const isPureRemoval = incoming.every((a) =>
						prev.some((p) => p.user.id === a.user.id),
					);
					if (isPureRemoval) return incoming;
					return mergeAccounts(prev, incoming);
				});
			}
		}
		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	useEffect(() => {
		const unsub = onUnauthorized((token) => {
			const leaving =
				readAccounts().find((a) => a.token === token) ?? null;
			const updated = readAccounts().filter((a) => a.token !== token);
			writeAccounts(updated);
			setAccounts(updated);
			// Scrub the last-active pointer too, or a restart would keep a
			// stale reference to the revoked session.
			if (readLastActiveToken() === token) {
				removeLastActiveToken();
			}
			// Like logout: wipe the evicted account's IDB unless another
			// live session of the same user still shares it.
			if (
				leaving !== null &&
				!updated.some((a) => a.user.id === leaving.user.id)
			) {
				void deleteAccountDB(leaving.user.id);
			}
			clearAccountSwitchState();
			if (activeToken === token) {
				const next = updated[0]?.token ?? null;
				setActiveToken(next);
				if (next === null) {
					removeActiveToken();
					void getRouter().navigate({
						to: "/login",
						search: { add: undefined },
					});
				} else {
					writeActiveToken(next);
				}
			}
		});
		return unsub;
	}, [activeToken]);

	const switchAccount = useCallback((token: string) => {
		setActiveToken(token);
		writeActiveToken(token);
	}, []);

	const addAccount = useCallback(
		(token: string, user: StoredUser, email: string, expiresAt: string) => {
			// Re-read storage at write time and merge by user id so an account
			// added concurrently from another tab is not overwritten.
			const updated = mergeAccounts(readAccounts(), [
				{ token, user, email, expiresAt },
			]);
			writeAccounts(updated);
			setAccounts(updated);
			setActiveToken(token);
			writeActiveToken(token);
			writeLastActiveToken(token);
		},
		[],
	);

	const removeAccount = useCallback(
		(token: string) => {
			const updated = readAccounts().filter((a) => a.token !== token);
			writeAccounts(updated);
			setAccounts(updated);
			// Scrub the last-active pointer when it referenced the removed
			// session, or a restart would keep pointing at a dead token.
			if (readLastActiveToken() === token) {
				removeLastActiveToken();
			}
			if (activeToken === token) {
				const next = updated[0]?.token ?? null;
				setActiveToken(next);
				if (next === null) {
					removeActiveToken();
					removeLastActiveToken();
					void getRouter().navigate({
						to: "/login",
						search: { add: undefined },
					});
				} else {
					writeActiveToken(next);
				}
			}
		},
		[activeToken],
	);

	const updateAccountToken = useCallback(
		(oldToken: string, newToken: string, newExpiresAt: string) => {
			const updated = readAccounts().map((a) =>
				a.token === oldToken
					? { ...a, token: newToken, expiresAt: newExpiresAt }
					: a,
			);
			writeAccounts(updated);
			setAccounts(updated);
			if (readActiveToken() === oldToken) {
				setActiveToken(newToken);
				writeActiveToken(newToken);
				if (readLastActiveToken() === oldToken) {
					writeLastActiveToken(newToken);
				}
			}
		},
		[],
	);

	const switchAccountWithCleanup = useCallback(
		(token: string) => {
			clearAccountSwitchState();
			switchAccount(token);
		},
		[switchAccount],
	);

	const logout = useCallback(() => {
		const token = activeToken;
		const leaving = accounts.find((a) => a.token === token) ?? null;
		removeAccount(token ?? "");
		clearAccountSwitchState();
		if (leaving !== null) {
			void deleteAccountDB(leaving.user.id);
		}

		// The token is revoked on the server as well: a token that only
		// disappears from this browser stays usable until it expires.
		if (token !== null) {
			void revokeSession(token);
		}
	}, [activeToken, accounts, removeAccount]);

	const activeAccount =
		activeToken !== null
			? (accounts.find((a) => a.token === activeToken) ?? null)
			: null;

	useEffect(() => {
		setActiveAccountKey(activeAccount?.user.id ?? null);
	}, [activeAccount]);

	return {
		accounts,
		activeAccount,
		switchAccount: switchAccountWithCleanup,
		addAccount,
		removeAccount,
		updateAccountToken,
		logout,
	};
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const value = useAuthState();
	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (ctx === null) {
		throw new Error("useAuth must be used within AuthProvider");
	}
	return ctx;
}
