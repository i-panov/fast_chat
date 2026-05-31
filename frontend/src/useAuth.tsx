import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { register as apiRegister } from "./api.ts";
import { onUnauthorized } from "./utils/authEvents.ts";

export interface StoredUser {
	id: string;
	nick: string;
}

export interface StoredAccount {
	token: string;
	user: StoredUser;
}

interface AuthContextValue {
	accounts: StoredAccount[];
	activeAccount: StoredAccount | null;
	switchAccount: (token: string) => void;
	addAccount: (token: string, user: StoredUser) => void;
	removeAccount: (token: string) => void;
	login: (nick: string) => Promise<void>;
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
		if (activeToken === null && accounts.length > 0) {
			const resolved = resolveActiveToken(accounts);
			if (resolved !== null) {
				setActiveToken(resolved);
			}
		}
	}, [accounts, activeToken]);

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
					window.location.href = "/login";
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

	const addAccount = useCallback((token: string, user: StoredUser) => {
		const updated = readAccounts();
		if (!updated.some((a) => a.token === token)) {
			updated.push({ token, user });
			writeAccounts(updated);
			setAccounts(updated);
		}
		setActiveToken(token);
		writeActiveToken(token);
		writeLastActiveToken(token);
	}, []);

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
					window.location.href = "/login";
				} else {
					writeActiveToken(next);
				}
			}
		},
		[activeToken],
	);

	const login = useCallback(
		async (nick: string) => {
			const { user, token } = await apiRegister(nick);
			addAccount(token, user);
		},
		[addAccount],
	);

	const logout = useCallback(() => {
		removeAccount(activeToken ?? "");
	}, [activeToken, removeAccount]);

	const activeAccount =
		activeToken !== null
			? (accounts.find((a) => a.token === activeToken) ?? null)
			: null;

	return {
		accounts,
		activeAccount,
		switchAccount,
		addAccount,
		removeAccount,
		login,
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
