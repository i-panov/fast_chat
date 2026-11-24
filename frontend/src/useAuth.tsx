import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import {
	getSessions,
	logoutAllSessions,
	refreshToken,
	revokeSession,
} from "./api.ts";
import { setActiveAccountKey, setActiveAccountKeySilently } from "./db/init.ts";
import { notify } from "./db/notify.ts";
import { clearLocalKeys } from "./e2ee/keys.ts";
import { getRouter } from "./router.tsx";
import {
	clearBackgroundSession,
	setBackgroundSession,
} from "./sync/backgroundSession.ts";
import {
	broadcastTokenRotation,
	onTokenRotation,
} from "./utils/authChannel.ts";
import {
	onUnauthorized,
	registerTokenReplacement,
} from "./utils/authEvents.ts";
import {
	clearAccountSwitchState,
	deleteAccountDB,
} from "./utils/clearAllData.ts";
import { getDeviceId, getDeviceName } from "./utils/device.ts";

interface StoredUser {
	id: string;
	nick: string;
	avatarUrl?: string;
	// Mirrors the public profile of the account. Older stored accounts
	// predate the field, so it is optional and read as false.
	isAdmin?: boolean;
	isBot?: boolean;
}

interface StoredAccount {
	token: string;
	user: StoredUser;
	email: string;
	expiresAt: string;
	sessionId?: string;
	deviceId?: string;
	deviceName?: string;
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
		sessionId?: string,
		deviceId?: string,
		deviceName?: string,
	) => void;
	removeAccount: (token: string) => void;
	updateAccountToken: (
		oldToken: string,
		newToken: string,
		newExpiresAt: string,
	) => void;
	updateAccountUser: (user: StoredUser) => void;
	logout: () => void;
	logoutAll: () => void;
	refreshAccountToken: (
		userId: string,
		oldToken: string,
	) => Promise<{ token: string; expiresAt: string }>;
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

// Web Locks serializes refreshes across tabs of the same origin. Without the
// API (older webviews, tests) the caller still refreshes, just without the
// cross-tab mutex.
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
	const locks = (
		navigator as Navigator & { locks?: { request: LockManager["request"] } }
	).locks;
	if (locks === undefined) return fn();
	return locks.request("fastchat-token-refresh", fn);
}

function useTokenRotationSync(
	setAccounts: (accounts: StoredAccount[]) => void,
	setActiveToken: (token: string) => void,
) {
	useEffect(() => {
		return onTokenRotation((message) => {
			const stored = readAccounts();
			let changed = false;
			const updated = stored.map((a) => {
				if (a.user.id !== message.userId || a.token !== message.oldToken) {
					return a;
				}
				changed = true;
				return { ...a, token: message.token, expiresAt: message.expiresAt };
			});
			if (changed) {
				writeAccounts(updated);
				setAccounts(updated);
			}
			registerTokenReplacement(message.oldToken, message.token);
			if (readActiveToken() === message.oldToken) {
				setActiveToken(message.token);
				writeActiveToken(message.token);
				if (readLastActiveToken() === message.oldToken) {
					writeLastActiveToken(message.token);
				}
			}
		});
	}, [setAccounts, setActiveToken]);
}

function useUnauthorizedSync(
	activeToken: string | null,
	setAccounts: (accounts: StoredAccount[]) => void,
	setActiveToken: (token: string | null) => void,
) {
	useEffect(() => {
		return onUnauthorized((token) => {
			const leaving = readAccounts().find((a) => a.token === token) ?? null;
			const updated = readAccounts().filter((a) => a.token !== token);
			writeAccounts(updated);
			setAccounts(updated);
			if (readLastActiveToken() === token) {
				removeLastActiveToken();
			}
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
	}, [activeToken, setAccounts, setActiveToken]);
}

// Accounts stored before multi-device do not carry a session id. Resolve the
// current one lazily: the devices list and the E2EE guard need it.
function useSessionHydration(
	activeAccount: StoredAccount | null,
	setAccounts: (accounts: StoredAccount[]) => void,
) {
	useEffect(() => {
		if (
			activeAccount === null ||
			activeAccount.sessionId !== undefined ||
			activeAccount.sessionId === ""
		) {
			return;
		}

		const token = activeAccount.token;
		const userID = activeAccount.user.id;
		let cancelled = false;
		try {
			void getSessions(token)
				.then((result) => {
					if (cancelled) return;
					const stored = readAccounts();
					const updated = stored.map((a) =>
						a.user.id === userID
							? {
									...a,
									sessionId: result.currentSessionId,
									deviceId: a.deviceId ?? getDeviceId(),
									deviceName: a.deviceName ?? getDeviceName(),
								}
							: a,
					);
					writeAccounts(updated);
					setAccounts(updated);
				})
				.catch(() => {
					// The next refresh retries; the devices list remains usable
					// without a stored session id.
				});
		} catch {
			// Partial API mocks in unit tests may omit this function; real
			// builds always provide it.
		}

		return () => {
			cancelled = true;
		};
	}, [activeAccount, setAccounts]);
}

// eslint-disable-next-line max-lines-per-function -- account state, token rotation and storage sync share one reducer-like hook.
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

	useUnauthorizedSync(activeToken, setAccounts, setActiveToken);
	useTokenRotationSync(setAccounts, setActiveToken);

	const switchAccount = useCallback((token: string) => {
		setActiveToken(token);
		writeActiveToken(token);
	}, []);

	const addAccount = useCallback(
		(
			token: string,
			user: StoredUser,
			email: string,
			expiresAt: string,
			sessionId?: string,
			deviceId?: string,
			deviceName?: string,
		) => {
			// Re-read storage at write time and merge by user id so an account
			// added concurrently from another tab is not overwritten.
			const updated = mergeAccounts(readAccounts(), [
				{ token, user, email, expiresAt, sessionId, deviceId, deviceName },
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
			const stored = readAccounts();
			const account = stored.find((a) => a.token === oldToken);
			const updated = stored.map((a) =>
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
			if (account !== undefined) {
				registerTokenReplacement(oldToken, newToken);
				broadcastTokenRotation({
					type: "token-rotated",
					userId: account.user.id,
					oldToken,
					token: newToken,
					expiresAt: newExpiresAt,
				});
			}
		},
		[],
	);

	const updateAccountUser = useCallback((user: StoredUser) => {
		const updated = readAccounts().map((a) =>
			a.user.id === user.id ? { ...a, user } : a,
		);
		writeAccounts(updated);
		setAccounts(updated);
	}, []);

	const refreshAccountToken = useCallback(
		(userId: string, oldToken: string) => {
			return withRefreshLock(async () => {
				// Another tab may have rotated the token while this tab was
				// waiting for the lock. Re-read storage instead of refreshing
				// the same session twice.
				const stored = readAccounts();
				const account = stored.find((a) => a.user.id === userId);
				if (account === undefined) {
					throw new Error("account is no longer stored");
				}
				if (account.token !== oldToken) {
					return { token: account.token, expiresAt: account.expiresAt };
				}

				const result = await refreshToken(oldToken);
				updateAccountToken(oldToken, result.token, result.expiresAt);
				return { token: result.token, expiresAt: result.expiresAt };
			});
		},
		[updateAccountToken],
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
			void clearLocalKeys().finally(() => deleteAccountDB(leaving.user.id));
		}

		// The token is revoked on the server as well: a token that only
		// disappears from this browser stays usable until it expires.
		if (token !== null) {
			void revokeSession(token);
		}
	}, [activeToken, accounts, removeAccount]);

	const logoutAll = useCallback(() => {
		const token = activeToken;
		const leaving = accounts.find((a) => a.token === token) ?? null;
		removeAccount(token ?? "");
		clearAccountSwitchState();
		if (leaving !== null) {
			void clearLocalKeys().finally(() => deleteAccountDB(leaving.user.id));
		}
		if (token !== null) {
			void logoutAllSessions(token).catch(() => {
				// The local session is gone either way; a failed network call
				// leaves other devices to expire normally.
			});
		}
	}, [activeToken, accounts, removeAccount]);

	const activeAccount =
		activeToken !== null
			? (accounts.find((a) => a.token === activeToken) ?? null)
			: null;

	// Select the account database synchronously: the children's effects run
	// before this provider's effects, and a key lookup in that window must
	// not read the shared pre-account database (the key would be generated
	// there and the "new key" prompt would return after every reload).
	setActiveAccountKeySilently(activeAccount?.user.id ?? null);

	useEffect(() => {
		const accountKey = activeAccount?.user.id ?? null;
		setActiveAccountKey(accountKey);
		// The render-time selection above is silent by design; the live
		// queries still have to re-read from the new database.
		notify();

		// The Service Worker cannot read the session storage: mirror the
		// active credentials so Background Sync can flush the outbox after
		// the last window is closed. Logout removes them.
		if (activeAccount === null) {
			void clearBackgroundSession();
			return;
		}

		void setBackgroundSession({
			token: activeAccount.token,
			accountKey: activeAccount.user.id,
		});
	}, [activeAccount]);

	useSessionHydration(activeAccount, setAccounts);

	return {
		accounts,
		activeAccount,
		switchAccount: switchAccountWithCleanup,
		addAccount,
		removeAccount,
		updateAccountToken,
		updateAccountUser,
		logout,
		logoutAll,
		refreshAccountToken,
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
