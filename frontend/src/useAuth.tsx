import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
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
import { clearLocalKeys, lockLocalKeys } from "./e2ee/keys.ts";
import { getRouter } from "./router.tsx";
import {
	clearBackgroundSession,
	setBackgroundSession,
} from "./sync/backgroundSession.ts";
import {
	ACCOUNTS_KEY,
	readAccounts,
	readLastActiveToken,
	readSessionToken,
	removeActiveToken,
	removeLastActiveToken,
	resolveActiveToken,
	type StoredAccount,
	type StoredUser,
	writeAccounts,
	writeActiveToken,
	writeLastActiveToken,
} from "./utils/activeToken.ts";
import {
	broadcastTokenRotation,
	onTokenRotation,
} from "./utils/authChannel.ts";
import {
	onUnauthorized,
	registerTokenReplacement,
	replacementToken,
} from "./utils/authEvents.ts";
import {
	clearAccountSwitchState,
	deleteAccountDB,
} from "./utils/clearAllData.ts";
import { getDeviceId, getDeviceName } from "./utils/device.ts";

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
	logoutAll: () => Promise<void>;
	// sessionExpired drops the dead token without erasing the account's local
	// database or E2EE key; the user can log back in and resume.
	sessionExpired: () => void;
	refreshAccountToken: (
		userId: string,
		oldToken: string,
	) => Promise<{ token: string; expiresAt: string }>;
}

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

const AuthContext = createContext<AuthContextValue | null>(null);

// Web Locks serializes refreshes across tabs of the same origin. Without the
// API (older webviews, tests) the caller still refreshes, just without the
// cross-tab mutex.
function withRefreshLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const locks = (
		navigator as Navigator & { locks?: { request: LockManager["request"] } }
	).locks;
	if (locks === undefined) return Promise.resolve(fn());
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
			if (readSessionToken() === message.oldToken) {
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
		function handleUnauthorized(token: string) {
			const stored = readAccounts();
			const account = stored.find((a) => a.token === token);
			if (account === undefined) {
				// A 401 races a token rotation: the server replaces the token
				// hash on refresh while a request with the old token is still
				// in flight. If another tab already stored the new token, the
				// old one is simply gone from the list — deleting anything
				// here would log the user out by accident.
				if (replacementToken(token) !== undefined) return;
				// Not stored at all: only scrub the pointers that still
				// reference the dead session.
				if (readLastActiveToken() === token) removeLastActiveToken();
				if (readSessionToken() === token) {
					const next = resolveActiveToken(stored);
					setActiveToken(next);
					if (next === null) {
						removeActiveToken();
						void getRouter().navigate({
							to: "/login",
							search: { add: undefined },
						});
					}
				}
				return;
			}

			const updated = stored.filter((a) => a.token !== token);
			writeAccounts(updated);
			setAccounts(updated);
			if (readLastActiveToken() === token) {
				removeLastActiveToken();
			}
			// An expired or rejected session is not a decision to erase local
			// data: keeping the account database (and its E2EE key) lets the
			// same account resume after a fresh login. explicit logout and
			// "clear data" still delete it. The unlocked master key, however,
			// must not stay in memory for a session that is dead.
			lockLocalKeys(account.user.id);
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
		}

		return onUnauthorized((token) => {
			// Take the refresh lock first: refreshAccountToken may be holding
			// it while the server has already rotated the token, and the check
			// above must run against the post-rotation storage.
			void withRefreshLock(() => handleUnauthorized(token));
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
		// Hydrate when the stored account has no session id yet, including the
		// empty-string value older builds could write.
		if (
			activeAccount === null ||
			(activeAccount.sessionId !== undefined && activeAccount.sessionId !== "")
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
			// e.key === null is a full localStorage.clear() from another tab.
			if (e.key !== ACCOUNTS_KEY && e.key !== null) return;
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
		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	useUnauthorizedSync(activeToken, setAccounts, setActiveToken);
	useTokenRotationSync(setAccounts, setActiveToken);

	const activeAccount =
		activeToken !== null
			? (accounts.find((a) => a.token === activeToken) ?? null)
			: null;
	const activeUserIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (activeAccount !== null) activeUserIdRef.current = activeAccount.user.id;
	}, [activeAccount]);

	// A logout or 401 in another tab only rewrites the shared account list;
	// this tab keeps its own sessionStorage token. Reconcile the two so the
	// tab either falls through to the next stored account or leaves for the
	// login page instead of rendering an empty chat that /login redirects
	// back into.
	useEffect(() => {
		if (activeToken === null) return;
		if (accounts.some((a) => a.token === activeToken)) return;

		const leaving = activeUserIdRef.current;
		if (leaving !== null) lockLocalKeys(leaving);

		const next = resolveActiveToken(accounts);
		if (next !== null) {
			setActiveToken(next);
			return;
		}
		removeActiveToken();
		removeLastActiveToken();
		setActiveToken(null);
		void getRouter().navigate({ to: "/login", search: { add: undefined } });
	}, [accounts, activeToken]);

	const switchAccount = useCallback((token: string) => {
		setActiveToken(token);
		writeActiveToken(token);
		writeLastActiveToken(token);
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
			// Signing in as another account must not leave the previous
			// account's master key unlocked in memory.
			if (activeAccount !== null && activeAccount.user.id !== user.id) {
				lockLocalKeys(activeAccount.user.id);
				clearAccountSwitchState();
			}
			setActiveToken(token);
			writeActiveToken(token);
			writeLastActiveToken(token);
		},
		[activeAccount],
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
			if (readSessionToken() === oldToken) {
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
			// Merge: profile updates carry only the fields they changed, and
			// replacing the whole object would drop isAdmin/isBot.
			a.user.id === user.id ? { ...a, user: { ...a.user, ...user } } : a,
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
			// Do not leave the previous account's master key unlocked in
			// memory while another account is active.
			const leaving = accounts.find((a) => a.token === activeToken);
			if (leaving !== undefined) lockLocalKeys(leaving.user.id);
			clearAccountSwitchState();
			switchAccount(token);
		},
		[accounts, activeToken, switchAccount],
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

	// logoutAll resolves only after the server has revoked the other devices:
	// the local session is dropped first, and a failed request is reported to
	// the caller so the UI does not claim that every device was signed out.
	const logoutAll = useCallback(async () => {
		const token = activeToken;
		const leaving = accounts.find((a) => a.token === token) ?? null;
		removeAccount(token ?? "");
		clearAccountSwitchState();
		if (leaving !== null) {
			void clearLocalKeys().finally(() => deleteAccountDB(leaving.user.id));
		}
		if (token !== null) {
			await logoutAllSessions(token);
		}
	}, [activeToken, accounts, removeAccount]);

	const sessionExpired = useCallback(() => {
		const token = activeToken;
		if (token === null) return;
		const leaving = accounts.find((a) => a.token === token);
		if (leaving !== undefined) lockLocalKeys(leaving.user.id);
		removeAccount(token);
		clearAccountSwitchState();
	}, [activeToken, accounts, removeAccount]);

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
		sessionExpired,
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
