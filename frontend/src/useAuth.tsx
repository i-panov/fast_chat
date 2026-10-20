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
	return sessionStorage.getItem(ACTIVE_TOKEN_KEY);
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
				setAccounts(readAccounts());
			}
		}
		window.addEventListener("storage", handleStorage);
		return () => window.removeEventListener("storage", handleStorage);
	}, []);

	useEffect(() => {
		const unsub = onUnauthorized((token) => {
			const updated = readAccounts().filter((a) => a.token !== token);
			writeAccounts(updated);
			setAccounts(updated);
			if (activeToken === token) {
				const next = updated[0]?.token ?? null;
				setActiveToken(next);
				if (next === null) {
					removeActiveToken();
					void getRouter().navigate({ to: "/login" });
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
			const updated = readAccounts();
			if (!updated.some((a) => a.token === token)) {
				updated.push({ token, user, email, expiresAt });
				writeAccounts(updated);
				setAccounts(updated);
			}
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
			if (activeToken === token) {
				const next = updated[0]?.token ?? null;
				setActiveToken(next);
				if (next === null) {
					removeActiveToken();
					removeLastActiveToken();
					void getRouter().navigate({ to: "/login" });
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

	const logout = useCallback(() => {
		const token = activeToken;
		removeAccount(token ?? "");

		// The token is revoked on the server as well: a token that only
		// disappears from this browser stays usable until it expires.
		if (token !== null) {
			void revokeSession(token);
		}
	}, [activeToken, removeAccount]);

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
		switchAccount,
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
