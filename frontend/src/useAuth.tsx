import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { register as apiRegister } from "./api";

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
const ACTIVE_TOKEN_KEY = "activeToken";

function readAccounts(): StoredAccount[] {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "[]") as StoredAccount[];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccount[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function readActiveToken(): string | null {
  return localStorage.getItem(ACTIVE_TOKEN_KEY);
}

function writeActiveToken(token: string | null) {
  if (token === null) {
    localStorage.removeItem(ACTIVE_TOKEN_KEY);
  } else {
    localStorage.setItem(ACTIVE_TOKEN_KEY, token);
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<StoredAccount[]>(() => readAccounts());
  const [activeToken, setActiveToken] = useState<string | null>(() => {
    const saved = readActiveToken();
    if (saved !== null && readAccounts().some((a) => a.token === saved)) {
      return saved;
    }
    return null;
  });

  const activeAccount =
    activeToken !== null
      ? accounts.find((a) => a.token === activeToken) ?? null
      : null;

  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === ACCOUNTS_KEY) {
        setAccounts(readAccounts());
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

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
  }, []);

  const removeAccount = useCallback((token: string) => {
    const updated = readAccounts().filter((a) => a.token !== token);
    writeAccounts(updated);
    setAccounts(updated);
    if (activeToken === token) {
      const next = updated[0]?.token ?? null;
      setActiveToken(next);
      writeActiveToken(next);
      if (next === null) {
        window.location.href = "/login";
      }
    }
  }, [activeToken]);

  const login = useCallback(async (nick: string) => {
    const { user, token } = await apiRegister(nick);
    addAccount(token, user);
  }, [addAccount]);

  const logout = useCallback(() => {
    removeAccount(activeToken ?? "");
  }, [activeToken, removeAccount]);

  return (
    <AuthContext.Provider
      value={{
        accounts,
        activeAccount,
        switchAccount,
        addAccount,
        removeAccount,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
