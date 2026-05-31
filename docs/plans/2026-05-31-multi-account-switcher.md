# Multi-Account Switcher + Cross-Tab Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple accounts to be logged in simultaneously within one browser, with cross-tab login persistence and a Telegram-style account-switching panel.

**Architecture:** Move from `sessionStorage` (tab-isolated) to `localStorage` (shared) for auth state. Add a React `AuthProvider` context that manages a list of `{token, user}` accounts and the currently active one. Add a sliding left panel in ChatPage listing all accounts with switch/add/logout actions. SSE reconnects on account switch.

**Tech Stack:** React 19, TypeScript, localStorage (cross-tab via `storage` event), SSE

---

### Task 1: Auth storage in localStorage + 401 handling in api.ts

**Files:**
- Modify: `frontend/src/api.ts:39-44`

- [ ] **Step 1: Replace sessionStorage 401 logic with localStorage account removal**

Change the 401 handler in `request()` to remove the failed token from the `localStorage.accounts` list and redirect only when no accounts remain.

```typescript
if (res.status === 401) {
  const raw = localStorage.getItem("accounts");
  if (raw !== null) {
    const accounts: Array<{ token: string; user: { id: string; nick: string } }> = JSON.parse(raw);
    const filtered = accounts.filter((a) => a.token !== token);
    localStorage.setItem("accounts", JSON.stringify(filtered));
    if (filtered.length === 0) {
      window.location.href = "/login";
    }
  } else {
    window.location.href = "/login";
  }
  throw new Error("unauthorized");
}
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 2: Create useAuth hook + AuthProvider

**Files:**
- Create: `frontend/src/useAuth.ts`

- [ ] **Step 1: Write useAuth.ts**

```typescript
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { register as apiRegister } from "../api";

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
    return () => window.removeEventListener("storage", handleStorage);
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
      const next = updated.length > 0 ? updated[0].token : null;
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
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 3: Wire AuthProvider into App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Wrap Routes with AuthProvider**

```typescript
import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage";
import ChatPage from "./pages/ChatPage";
import { AuthProvider } from "./useAuth";

function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 4: Refactor LoginPage to useAuth

**Files:**
- Modify: `frontend/src/pages/LoginPage.tsx`

- [ ] **Step 1: Replace sessionStorage with useAuth().login**

```typescript
import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../useAuth";

export default function LoginPage() {
  const [nick, setNick] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login, accounts } = useAuth();

  if (accounts.length > 0) {
    void navigate("/chat", { replace: true });
    return null;
  }

  async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = nick.trim();
    if (trimmed.length === 0) return;

    setLoading(true);
    setError("");
    try {
      await login(trimmed);
      void navigate("/chat", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>Fast Chat</h1>
        <p className="login-hint">Enter your nickname to join</p>
        <input
          type="text"
          placeholder="Nickname"
          maxLength={20}
          value={nick}
          onChange={(e) => { setNick(e.target.value); }}
          autoFocus
        />
        {error.length > 0 && <p className="error">{error}</p>}
        <button type="submit" disabled={loading || nick.trim().length === 0}>
          {loading ? "Joining..." : "Join"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 5: Create AccountSwitcher component + Add Account form

**Files:**
- Create: `frontend/src/AccountSwitcher.tsx`

- [ ] **Step 1: Write AccountSwitcher.tsx**

```typescript
import { useState, type SubmitEvent } from "react";
import { useAuth } from "./useAuth";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AccountSwitcher({ open, onClose }: Props) {
  const { accounts, activeAccount, switchAccount, login, removeAccount } = useAuth();
  const [adding, setAdding] = useState(false);
  const [newNick, setNewNick] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleAdd(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = newNick.trim();
    if (trimmed.length === 0) return;

    setLoading(true);
    setError("");
    try {
      await login(trimmed);
      setAdding(false);
      setNewNick("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  function handleAccountClick(token: string) {
    if (token !== activeAccount?.token) {
      switchAccount(token);
      onClose();
    }
  }

  return (
    <>
      {open && <div className="switcher-overlay" onClick={onClose} />}
      <div className={`switcher-panel ${open ? "open" : ""}`}>
        <div className="switcher-header">
          <h2>Accounts</h2>
        </div>

        <div className="switcher-list">
          {accounts.map((acc) => (
            <button
              key={acc.token}
              className={`switcher-item ${acc.token === activeAccount?.token ? "active" : ""}`}
              onClick={() => { handleAccountClick(acc.token); }}
            >
              <span className="switcher-avatar">
                {acc.user.nick[0].toUpperCase()}
              </span>
              <span className="switcher-nick">@{acc.user.nick}</span>
              {acc.token === activeAccount?.token && (
                <span className="switcher-check">✓</span>
              )}
            </button>
          ))}
        </div>

        <div className="switcher-bottom">
          {adding ? (
            <form className="switcher-add-form" onSubmit={handleAdd}>
              <input
                type="text"
                placeholder="Nickname"
                maxLength={20}
                value={newNick}
                onChange={(e) => { setNewNick(e.target.value); }}
                autoFocus
              />
              {error.length > 0 && <p className="error">{error}</p>}
              <div className="switcher-add-actions">
                <button type="submit" disabled={loading || newNick.trim().length === 0}>
                  {loading ? "Adding..." : "Add"}
                </button>
                <button type="button" onClick={() => { setAdding(false); setError(""); }}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button className="switcher-add-btn" onClick={() => { setAdding(true); }}>
              + Add Account
            </button>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 6: Refactor ChatPage to useAuth + integrate AccountSwitcher + SSE reconnection

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`

- [ ] **Step 1: Replace sessionStorage with useAuth, add AccountSwitcher, reconnect SSE on account switch**

```typescript
import { useEffect, useState, type SubmitEvent, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  getChats,
  searchUsers,
  createChat,
  getMessages,
  sendMessage,
} from "../api";
import type { User, Chat, Message, MemberInfo } from "../api";
import { useSSE } from "../useSSE";
import { useAuth } from "../useAuth";
import AccountSwitcher from "../AccountSwitcher";

function otherNick(members: MemberInfo[], myId: string): string {
  return members.find((m) => m.id !== myId)?.nick ?? "Unknown";
}

export default function ChatPage() {
  const navigate = useNavigate();
  const { activeAccount, accounts, switchAccount, removeAccount, logout } = useAuth();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const [user, setUser] = useState<{ id: string; nick: string } | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [inputText, setInputText] = useState("");

  const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
  const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);

  const seenMessageIds = useRef(new Set<string>());

  // Sync user from activeAccount
  useEffect(() => {
    if (activeAccount !== null) {
      setUser({
        id: activeAccount.user.id,
        nick: activeAccount.user.nick,
      });
    } else {
      setUser(null);
    }
  }, [activeAccount]);

  // Redirect to login if no active account
  useEffect(() => {
    if (activeAccount === null) {
      void navigate("/login", { replace: true });
    }
  }, [activeAccount, navigate]);

  // Re-fetch chats when account changes
  useEffect(() => {
    if (activeAccount === null) return;
    setChats([]);
    setActiveChatId(null);
    setMessages({});
    setPendingChatWith(null);
    setPendingChatNick(null);
    setInputText("");
    setSearchQuery("");
    setSearchResults([]);
    seenMessageIds.current = new Set();

    void getChats(activeAccount.token).then(({ chats: fetchedChats }) => {
      setChats(fetchedChats);
    });
  }, [activeAccount?.token]);

  const handleSSEEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === "new_message") {
        const msg = data as Message;
        if (seenMessageIds.current.has(msg.id)) return;
        seenMessageIds.current.add(msg.id);
        setMessages((prev) => ({
          ...prev,
          [msg.chat_id]: [...(prev[msg.chat_id] ?? []), msg],
        }));
      } else if (event === "chat_created") {
        const chat = data as Chat;
        setChats((prev) => {
          if (prev.some((c) => c.id === chat.id)) return prev;
          return [...prev, chat];
        });
      }
    },
    [],
  );

  useSSE(activeAccount?.token ?? "", handleSSEEvent);

  useEffect(() => {
    if (searchQuery.length < 1 || activeAccount === null) return;
    const timer = setTimeout(() => {
      void searchUsers(activeAccount.token, searchQuery).then(({ users }) => {
        setSearchResults(users);
      });
    }, 300);
    return () => { clearTimeout(timer); };
  }, [searchQuery, activeAccount?.token]);

  function selectChat(chatId: string) {
    if (activeAccount === null) return;
    setPendingChatWith(null);
    setPendingChatNick(null);
    setActiveChatId(chatId);
    if (messages[chatId] === undefined) {
      void getMessages(activeAccount.token, chatId).then(({ messages: msgs }) => {
        setMessages((prev) => ({ ...prev, [chatId]: msgs }));
      });
    }
  }

  function selectPendingChat(withUserId: string, withUserNick: string) {
    setPendingChatWith(withUserId);
    setPendingChatNick(withUserNick);
    setActiveChatId(null);
    setSearchQuery("");
    setSearchResults([]);
  }

  async function handleSend(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (activeAccount === null || inputText.trim().length === 0) return;

    const text = inputText;
    setInputText("");

    if (pendingChatWith !== null) {
      try {
        const { chat } = await createChat(activeAccount.token, pendingChatWith);
        setChats((prev) =>
          prev.some((c) => c.id === chat.id) ? prev : [...prev, chat],
        );
        setActiveChatId(chat.id);
        setPendingChatWith(null);
        setPendingChatNick(null);
        await sendMessage(activeAccount.token, chat.id, text);
      } catch {
        setInputText(text);
      }
      return;
    }

    if (activeChatId === null) return;

    try {
      await sendMessage(activeAccount.token, activeChatId, text);
    } catch {
      setInputText(text);
    }
  }

  function handleLogout() {
    logout();
  }

  const activeChat =
    pendingChatWith !== null
      ? undefined
      : chats.find((c) => c.id === activeChatId);

  const activeMessages =
    activeChatId !== null ? (messages[activeChatId] ?? []) : [];

  const showSearchResults =
    searchQuery.length >= 1 && searchResults.length > 0;

  if (activeAccount === null || user === null) return null;

  return (
    <div className="chat-layout">
      <AccountSwitcher open={switcherOpen} onClose={() => { setSwitcherOpen(false); }} />
      <header className="app-header">
        <button className="switcher-toggle" onClick={() => { setSwitcherOpen(true); }}>
          ☰
        </button>
        <span className="user-info">
          @{activeAccount.user.nick}
          {accounts.length > 1 && (
            <span className="account-count">+{accounts.length - 1}</span>
          )}
        </span>
        <button className="logout-btn" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <div className="chat-page">
        <aside className="sidebar">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.length < 1) setSearchResults([]);
              }}
              autoFocus
            />
            {showSearchResults && (
              <div className="search-results">
                {searchResults.map((u) => (
                  <button
                    key={u.id}
                    className="search-result-item"
                    onClick={() => { selectPendingChat(u.id, u.nick); }}
                  >
                    @{u.nick} {u.online ? "(online)" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="chat-list">
            {chats.length === 0 && (
              <p className="empty-state">
                No chats yet. Search for a user above to start one.
              </p>
            )}
            {chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-list-item ${chat.id === activeChatId ? "active" : ""}`}
                onClick={() => { selectChat(chat.id); }}
              >
                @{otherNick(chat.members, user.id)}
              </button>
            ))}
          </div>
        </aside>

        <main className="chat-main">
          {pendingChatWith !== null ? (
            <>
              <header className="chat-header">
                @{pendingChatNick}
                <span className="chat-header-badge">New chat</span>
              </header>
              <div className="messages">
                <p className="empty-state">
                  Send a message to start a chat with @{pendingChatNick}
                </p>
              </div>
              <form className="input-bar" onSubmit={handleSend}>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={inputText}
                  onChange={(e) => { setInputText(e.target.value); }}
                  autoFocus
                />
                <button type="submit" disabled={inputText.trim().length === 0}>
                  Send
                </button>
              </form>
            </>
          ) : activeChat === undefined ? (
            <div className="no-chat">
              <p>Select a chat or search for a user to start messaging</p>
            </div>
          ) : (
            <>
              <header className="chat-header">
                @{otherNick(activeChat.members, user.id)}
              </header>
              <div className="messages">
                {activeMessages.length === 0 && (
                  <p className="empty-state">No messages yet</p>
                )}
                {activeMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message ${msg.from_id === user.id ? "own" : ""}`}
                  >
                    <div className="message-nick">{msg.from_nick}</div>
                    <div className="message-text">{msg.text}</div>
                  </div>
                ))}
              </div>
              <form className="input-bar" onSubmit={handleSend}>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={inputText}
                  onChange={(e) => { setInputText(e.target.value); }}
                  autoFocus
                />
                <button type="submit" disabled={inputText.trim().length === 0}>
                  Send
                </button>
              </form>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 7: Refactor useSSE to remove sessionStorage dependency

**Files:**
- Modify: `frontend/src/useSSE.ts`

- [ ] **Step 1: Remove sessionStorage references from useSSE**

```typescript
import { useEffect, useRef } from "react";

type EventHandler = (event: string, data: unknown) => void;

function isClosed(source: EventSource): boolean {
  try {
    return source.readyState === EventSource.CLOSED;
  } catch {
    return true;
  }
}

export function useSSE(token: string, onEvent: EventHandler) {
  const onEventRef = useRef<EventHandler>(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (token === "") return;

    const url = `/api/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);

    source.addEventListener("new_message", (e) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        onEventRef.current("new_message", data);
      } catch { /* ignore */ }
    });

    source.addEventListener("chat_created", (e) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        onEventRef.current("chat_created", data);
      } catch { /* ignore */ }
    });

    source.addEventListener("connected", () => {
      onEventRef.current("connected", null);
    });

    source.onerror = () => {
      if (isClosed(source)) {
        onEventRef.current("sse_closed", null);
        return;
      }
      onEventRef.current("error", null);
    };

    return () => { source.close(); };
  }, [token]);
}
```

- [ ] **Step 2: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 8: Add CSS styles for account switcher panel

**Files:**
- Modify: `frontend/src/App.css` (append at end)

- [ ] **Step 1: Add switcher styles**

```css
/* Account Switcher */
.switcher-toggle {
  background: none;
  border: none;
  color: #e0e0e0;
  font-size: 1.2rem;
  cursor: pointer;
  padding: 0.25rem;
  margin-right: 0.5rem;
  line-height: 1;
}

.account-count {
  margin-left: 0.3rem;
  font-size: 0.75rem;
  color: #888;
  font-weight: 400;
}

.switcher-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.switcher-panel {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: 280px;
  background: #16213e;
  z-index: 101;
  display: flex;
  flex-direction: column;
  transform: translateX(-100%);
  transition: transform 0.25s ease;
}

.switcher-panel.open {
  transform: translateX(0);
}

.switcher-header {
  padding: 1rem;
  border-bottom: 1px solid #1a1a2e;
}

.switcher-header h2 {
  font-size: 1.1rem;
  color: #e0e0e0;
}

.switcher-list {
  flex: 1;
  overflow-y: auto;
}

.switcher-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  border: none;
  background: none;
  color: #e0e0e0;
  text-align: left;
  cursor: pointer;
  font-size: 0.95rem;
  border-bottom: 1px solid #1a1a2e;
}

.switcher-item:hover {
  background: #1a1a2e;
}

.switcher-item.active {
  background: #0f3460;
}

.switcher-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #0f3460;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1rem;
  flex-shrink: 0;
}

.switcher-nick {
  flex: 1;
}

.switcher-check {
  font-size: 1.1rem;
  color: #2ecc71;
}

.switcher-bottom {
  padding: 1rem;
  border-top: 1px solid #1a1a2e;
}

.switcher-add-btn {
  width: 100%;
  padding: 0.6rem;
  border: 1px dashed #555;
  border-radius: 8px;
  background: none;
  color: #e0e0e0;
  font-size: 0.9rem;
  cursor: pointer;
  transition: background 0.2s;
}

.switcher-add-btn:hover {
  background: #1a1a2e;
}

.switcher-add-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.switcher-add-form input {
  padding: 0.6rem;
  border: 1px solid #333;
  border-radius: 8px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 0.9rem;
  outline: none;
}

.switcher-add-form input:focus {
  border-color: #0f3460;
}

.switcher-add-actions {
  display: flex;
  gap: 0.5rem;
}

.switcher-add-actions button {
  flex: 1;
  padding: 0.5rem;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.2s;
}

.switcher-add-actions button[type="submit"] {
  background: #0f3460;
  color: white;
}

.switcher-add-actions button[type="submit"]:hover:not(:disabled) {
  background: #1a5276;
}

.switcher-add-actions button[type="submit"]:disabled {
  opacity: 0.5;
  cursor: default;
}

.switcher-add-actions button[type="button"] {
  background: #333;
  color: #e0e0e0;
}

.switcher-add-actions button[type="button"]:hover {
  background: #444;
}
```

- [ ] **Step 2: Remove unused `user` state import in ChatPage**

The `User` type import `import type { User, Chat, Message, MemberInfo }` will still be needed because `User` is used for search results. But the `user` state in ChatPage is now derived from `activeAccount.user` instead of `sessionStorage`. The `User` type has `online` field which is not stored locally — search results will still use `api.User`. That's fine.

- [ ] **Step 3: Run frontend lint**

Run: `make frontend:lint`
Expected: 0 errors

### Task 9: Verify the full build and lint

**Files:**
- All modified files

- [ ] **Step 1: Run full lint**

Run: `make frontend:lint && make backend:lint`
Expected: 0 errors

- [ ] **Step 2: Run frontend dev server to check for runtime errors**

Run: `make frontend:run` (check for compile errors in terminal)

- [ ] **Step 3: Run backend to verify server starts**

Run: `make backend:run` (check for startup errors)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: multi-account switcher with cross-tab persistence

- Move auth state from sessionStorage to localStorage
- Add useAuth hook and AuthProvider context
- Add AccountSwitcher sliding left panel (Telegram-style)
- Support adding and switching between multiple accounts
- Cross-tab sync via storage event
- SSE reconnects on account switch
- 401 errors remove only the affected account"
```
