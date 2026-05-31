import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { register as apiRegister } from "./api.ts";

interface StoredUser {
	id: string;
	nick: string;
}

interface StoredAccount {
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
const SS_ACTIVE_TOKEN_KEY = "activeToken";
const LS_ACTIVE_TOKEN_KEY = "activeToken";

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
	return sessionStorage.getItem(SS_ACTIVE_TOKEN_KEY);
}

function writeActiveToken(token: string) {
	sessionStorage.setItem(SS_ACTIVE_TOKEN_KEY, token);
	localStorage.setItem(LS_ACTIVE_TOKEN_KEY, token);
}

function removeActiveToken() {
	sessionStorage.removeItem(SS_ACTIVE_TOKEN_KEY);
	localStorage.removeItem(LS_ACTIVE_TOKEN_KEY);
}

function resolveActiveToken(stored: StoredAccount[]): string | null {
	const sessionToken = readActiveToken();
	if (sessionToken !== null && stored.some((a) => a.token === sessionToken)) {
		return sessionToken;
	}
	const saved = localStorage.getItem(LS_ACTIVE_TOKEN_KEY);
	if (saved !== null && stored.some((a) => a.token === saved)) {
		writeActiveToken(saved);
		return saved;
	}
	const first = stored[0]?.token ?? null;
	if (first !== null) {
		writeActiveToken(first);
	}
	return first;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useAuthCallbacks(
	activeToken: string | null,
	setActiveToken: (v: string | null) => void,
	setAccounts: React.Dispatch<React.SetStateAction<StoredAccount[]>>,
) {
	const switchAccount = useCallback(
		(token: string) => {
			setActiveToken(token);
			writeActiveToken(token);
		},
		[setActiveToken],
	);

	const addAccount = useCallback(
		(token: string, user: StoredUser) => {
			const updated = readAccounts();
			if (!updated.some((a) => a.token === token)) {
				updated.push({ token, user });
				writeAccounts(updated);
				setAccounts(updated);
			}
			setActiveToken(token);
			writeActiveToken(token);
		},
		[setActiveToken, setAccounts],
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
					window.location.href = "/login";
				} else {
					writeActiveToken(next);
				}
			}
		},
		[activeToken, setActiveToken, setAccounts],
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

	return { switchAccount, addAccount, removeAccount, login, logout };
}

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

	const activeAccount =
		activeToken !== null
			? (accounts.find((a) => a.token === activeToken) ?? null)
			: null;

	const callbacks = useAuthCallbacks(activeToken, setActiveToken, setAccounts);

	return { accounts, activeAccount, ...callbacks };
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
