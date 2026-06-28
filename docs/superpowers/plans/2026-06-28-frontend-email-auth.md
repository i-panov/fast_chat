# Frontend Email Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rewrite frontend auth to use email-based 3-step flow, SSE without token in URL, and token expiry handling.

**Architecture:** LoginPage manages 3-step state (email → code → nick). SSE generates connectionId via `crypto.randomUUID()`, authenticates via `POST /api/auth/sse-auth` after connection opens. Token expiry triggers automatic refresh via `POST /api/auth/refresh-token`. AccountSwitcher no longer has inline add form — redirects to `/login`.

**Tech Stack:** React 19, TanStack Router, Mantine v9, Tailwind v4, EventSource

---

### Task 1: api.ts — Add auth API functions

**File:** `frontend/src/api.ts`

- [ ] **Step 1: Remove `register()` function**

Delete lines 115-120:
```ts
export function register(nick: string) {
	return request<{ user: User; token: string }>("/api/register", undefined, {
		method: "POST",
		body: JSON.stringify({ nick }),
	});
}
```

- [ ] **Step 2: Add `sendCode()`**

```ts
export function sendCode(email: string) {
	return request<{ status: string; debugCode?: string }>(
		"/api/auth/send-code",
		undefined,
		{ method: "POST", body: JSON.stringify({ email }) },
	);
}
```

- [ ] **Step 3: Add `verifyCode()`**

```ts
export interface VerifyCodeExisting {
	isNew: false;
	user: User;
	token: string;
	expiresAt: string;
}

export interface VerifyCodeNew {
	isNew: true;
	setupToken: string;
}

export type VerifyCodeResult = VerifyCodeExisting | VerifyCodeNew;

export function verifyCode(email: string, code: string) {
	return request<VerifyCodeResult>("/api/auth/verify-code", undefined, {
		method: "POST",
		body: JSON.stringify({ email, code }),
	});
}
```

- [ ] **Step 4: Add `completeRegistration()`**

```ts
export function completeRegistration(setupToken: string, nick: string) {
	return request<{ user: User; token: string; expiresAt: string }>(
		"/api/auth/complete-registration",
		undefined,
		{ method: "POST", body: JSON.stringify({ setupToken, nick }) },
	);
}
```

- [ ] **Step 5: Add `refreshToken()`**

```ts
export function refreshToken(token: string) {
	return request<{ token: string; expiresAt: string }>(
		"/api/auth/refresh-token",
		token,
		{ method: "POST" },
	);
}
```

- [ ] **Step 6: Add `sseAuth()`**

```ts
export function sseAuth(connectionId: string, token: string) {
	return request<{ status: string }>("/api/auth/sse-auth", undefined, {
		method: "POST",
		body: JSON.stringify({ connectionId, token }),
	});
}
```

- [ ] **Step 7: Run lint and build**

```bash
cd frontend && npx biome check src/api.ts && npm run build
```
Expected: no errors

---

### Task 2: useAuth.tsx — Add email/expiresAt to StoredAccount, remove login, add updateAccountToken

**File:** `frontend/src/useAuth.tsx`

- [ ] **Step 1: Update `StoredAccount` interface**

Change:
```ts
export interface StoredAccount {
	token: string;
	user: StoredUser;
}
```
To:
```ts
export interface StoredAccount {
	token: string;
	user: StoredUser;
	email: string;
	expiresAt: string;
}
```

- [ ] **Step 2: Update `AuthContextValue` — remove `login`, add `updateAccountToken`**

Change:
```ts
interface AuthContextValue {
	accounts: StoredAccount[];
	activeAccount: StoredAccount | null;
	switchAccount: (token: string) => void;
	addAccount: (token: string, user: StoredUser) => void;
	removeAccount: (token: string) => void;
	login: (nick: string) => Promise<void>;
	logout: () => void;
}
```
To:
```ts
interface AuthContextValue {
	accounts: StoredAccount[];
	activeAccount: StoredAccount | null;
	switchAccount: (token: string) => void;
	addAccount: (token: string, user: StoredUser, email: string, expiresAt: string) => void;
	removeAccount: (token: string) => void;
	updateAccountToken: (oldToken: string, newToken: string, newExpiresAt: string) => void;
	logout: () => void;
}
```

- [ ] **Step 3: Remove `import { register as apiRegister }` line**

Change:
```ts
import { register as apiRegister } from "./api.ts";
```
To: (remove the import entirely — apiRegister is no longer used)

- [ ] **Step 4: Update `addAccount` signature and implementation**

Change:
```ts
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
```
To:
```ts
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
```

- [ ] **Step 5: Add `updateAccountToken` function**

Add after `addAccount`:
```ts
const updateAccountToken = useCallback(
	(oldToken: string, newToken: string, newExpiresAt: string) => {
		const updated = readAccounts().map((a) =>
			a.token === oldToken ? { ...a, token: newToken, expiresAt: newExpiresAt } : a,
		);
		writeAccounts(updated);
		setAccounts(updated);
		if (readActiveToken() === oldToken) {
			writeActiveToken(newToken);
			if (readLastActiveToken() === oldToken) {
				writeLastActiveToken(newToken);
			}
		}
	},
	[],
);
```

- [ ] **Step 6: Remove the `login` callback**

Delete lines (the whole `login` callback):
```ts
const login = useCallback(
	async (nick: string) => {
		const { user, token } = await apiRegister(nick);
		addAccount(token, user);
	},
	[addAccount],
);
```

- [ ] **Step 7: Update returned value — remove `login`, add `updateAccountToken`**

Change:
```ts
return {
	accounts,
	activeAccount,
	switchAccount,
	addAccount,
	removeAccount,
	login,
	logout,
};
```
To:
```ts
return {
	accounts,
	activeAccount,
	switchAccount,
	addAccount,
	removeAccount,
	updateAccountToken,
	logout,
};
```

- [ ] **Step 8: Run lint and build**

```bash
cd frontend && npx biome check src/useAuth.tsx && npm run build
```
Expected: build errors because AccountSwitcher still references `login` — that's expected for now

---

### Task 3: AccountSwitcher.tsx — Replace inline "Add account" with redirect

**File:** `frontend/src/AccountSwitcher.tsx`

- [ ] **Step 1: Update imports — remove `login` from useAuth destructuring, add `useNavigate`**

Change line 18:
```ts
import { useAuth } from "./useAuth.tsx";
```
To:
```ts
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "./useAuth.tsx";
```

- [ ] **Step 2: Replace Footer with simplified version — "Add account" button redirects to /login**

Replace the entire `Footer` component and `handleSubmit` function with:

```tsx
function Footer({ onAddClick }: { onAddClick: () => void }) {
	const { t } = useTranslation();

	return (
		<Button
			variant="outline"
			style={{ width: "100%", borderStyle: "dashed" }}
			onClick={onAddClick}
		>
			{t("accounts.add")}
		</Button>
	);
}
```

Delete the `handleSubmit` function entirely (lines 183-213).

- [ ] **Step 3: Update `AccountSwitcher` component — remove form state, use navigate**

Change the component body:
```tsx
export function AccountSwitcher({ open, onClose, onLogout }: Props) {
	const { t } = useTranslation();
	const { accounts, activeAccount, switchAccount } = useAuth();
	const [confirmLogout, setConfirmLogout] = useState(false);
	const navigate = useNavigate();
```
Remove these lines (no longer needed):
```tsx
const [adding, setAdding] = useState(false);
const [newNick, setNewNick] = useState("");
const [error, setError] = useState("");
const [loading, setLoading] = useState(false);
```

- [ ] **Step 4: Update the Footer usage in the render**

Change the Footer JSX block:
```tsx
<Footer
	adding={adding}
	error={error}
	loading={loading}
	newNick={newNick}
	setNewNick={setNewNick}
	onSubmit={(e) =>
		handleSubmit(e, {
			newNick,
			login,
			setAdding,
			setNewNick,
			setError,
			setLoading,
			onClose,
			registerError: t("error.register"),
		})
	}
	onCancel={() => {
		setAdding(false);
		setError("");
	}}
	onAddClick={() => setAdding(true)}
/>
```
To:
```tsx
<Footer
	onAddClick={() => {
		onClose();
		navigate({ to: "/login" });
	}}
/>
```

- [ ] **Step 5: Remove unused imports**

Remove `FormEvent` from the import:
```tsx
import type { FormEvent } from "react";
```
Also remove `Modal, Overlay` — wait, Modal and Overlay are used elsewhere in the file. Only remove `FormEvent`. Actually Modal is used for the logout confirmation. Keep Modal. Overlay is used. ScrollArea is used. TextInput is no longer used, remove it from the import. Stack is no longer used, remove it. Group is used for the Modal buttons.

Update the import block:
```tsx
import {
	Button,
	Modal,
	Overlay,
	ScrollArea,
	Select,
	Group,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useState } from "react";
```

- [ ] **Step 6: Run lint and build**

```bash
cd frontend && npx biome check src/AccountSwitcher.tsx && npm run build
```
Expected: no errors

---

### Task 4: useSse.ts — Rewrite with connectionId and sseAuth

**File:** `frontend/src/useSse.ts`

- [ ] **Step 1: Rewrite the entire file**

Replace the full content with:

```ts
import { useEffect, useRef } from "react";
import { sseAuth } from "./api.ts";

type EventHandler = (event: string, data: unknown) => void;

function isClosed(source: EventSource): boolean {
	try {
		return source.readyState === EventSource.CLOSED;
	} catch {
		return true;
	}
}

export function useSse(token: string, onEvent: EventHandler) {
	const onEventRef = useRef<EventHandler>(onEvent);
	const connectionIdRef = useRef<string>(crypto.randomUUID());

	useEffect(() => {
		onEventRef.current = onEvent;
	}, [onEvent]);

	useEffect(() => {
		if (token === "") {
			return;
		}

		const connectionId = connectionIdRef.current;
		const url = `/api/events?connectionId=${encodeURIComponent(connectionId)}`;
		const source = new EventSource(url);

		source.addEventListener("new_message", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("new_message", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_created", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_created", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_updated", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_updated", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_deleted", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_deleted", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_member_added", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_member_added", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_member_removed", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_member_removed", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("message_updated", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("message_updated", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("message_deleted", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("message_deleted", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("thread_created", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("thread_created", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("thread_message_new", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("thread_message_new", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("typing", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("typing", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("typing_stop", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("typing_stop", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("connected", () => {
			onEventRef.current("connected", null);
		});

		source.onopen = () => {
			void sseAuth(connectionId, token);
		};

		source.onerror = () => {
			if (isClosed(source)) {
				onEventRef.current("sse_closed", null);
				return;
			}
			onEventRef.current("error", null);
		};

		return () => {
			source.close();
		};
	}, [token]);
}
```

Key changes from the original:
1. Added `connectionIdRef` with `crypto.randomUUID()`
2. URL changed from `/api/events?token=...` to `/api/events?connectionId=...`
3. Added `source.onopen` that calls `void sseAuth(connectionId, token)`
4. Effect dependency stays `[token]` — when token changes (after refresh), the EventSource reconnects with the same connectionId and re-authenticates

- [ ] **Step 2: Run lint and build**

```bash
cd frontend && npx biome check src/useSse.ts && npm run build
```
Expected: no errors

---

### Task 5: useSseEvents.ts — Add token_expiring and token_expired handlers

**File:** `frontend/src/hooks/useSseEvents.ts`

- [ ] **Step 1: Update the hook to accept auth helpers and handle token events**

Rewrite the file:

```ts
import { useCallback } from "react";
import type { Chat, Message, Thread, TypingPayload } from "../api.ts";
import { refreshToken } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import { useSse } from "../useSse.ts";

interface UseSseEventsParams {
	token: string;
	setThreadsMap: React.Dispatch<React.SetStateAction<Record<string, Thread>>>;
	setThreadMessagesMap: React.Dispatch<
		React.SetStateAction<Record<string, Message[]>>
	>;
	setMessageToThreadMap: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
	addTypingUser: (payload: TypingPayload) => void;
	clearTyping: (chatId: string, userId: string) => void;
	onTokenExpiring: (currentToken: string) => Promise<void>;
	onTokenExpired: () => void;
}

export function useSseEvents({
	token,
	setThreadsMap,
	setThreadMessagesMap,
	setMessageToThreadMap,
	addTypingUser,
	clearTyping,
	onTokenExpiring,
	onTokenExpired,
}: UseSseEventsParams) {
	const handler = useCallback(
		(event: string, data: unknown) => {
			if (event === "new_message" || event === "message_updated") {
				const msg = data as Message;
				void messagesRepo.upsert(msg);
				return;
			}
			if (event === "message_deleted") {
				const { chatId, messageId } = data as {
					chatId: string;
					messageId: string;
				};
				void messagesRepo.applyDelete(chatId, messageId);
				return;
			}
			if (
				event === "chat_created" ||
				event === "chat_updated" ||
				event === "chat_member_added" ||
				event === "chat_member_removed"
			) {
				const chat = data as Chat;
				void chatsRepo.upsert(chat);
				return;
			}
			if (event === "chat_deleted") {
				const { chatId } = data as { chatId: string };
				void chatsRepo.remove(chatId);
				return;
			}
			if (event === "thread_created") {
				const thread = data as Thread;
				setThreadsMap((prev) => {
					if (prev[thread.id] !== undefined) return prev;
					return { ...prev, [thread.id]: thread };
				});
				setMessageToThreadMap((prev) => ({
					...prev,
					[thread.parentMessageId]: thread.id,
				}));
				return;
			}
			if (event === "thread_message_new") {
				const { threadId, message } = data as {
					threadId: string;
					message: Message;
				};
				setThreadMessagesMap((prev) => {
					const list = prev[threadId] ?? [];
					const idx = list.findIndex((m) => m.id === message.id);
					if (idx !== -1) {
						const next = [...list];
						next[idx] = message;
						return { ...prev, [threadId]: next };
					}
					return { ...prev, [threadId]: [...list, message] };
				});
				setThreadsMap((prev) => {
					const t = prev[threadId];
					if (t === undefined) return prev;
					return {
						...prev,
						[threadId]: { ...t, messageCount: t.messageCount + 1 },
					};
				});
				return;
			}
			if (event === "typing") {
				const payload = data as TypingPayload;
				addTypingUser(payload);
				return;
			}
			if (event === "typing_stop") {
				const { chatId, userId } = data as {
					chatId: string;
					userId: string;
				};
				clearTyping(chatId, userId);
				return;
			}
			if (event === "token_expiring") {
				void onTokenExpiring(token);
				return;
			}
			if (event === "token_expired") {
				onTokenExpired();
				return;
			}
			if (event === "sse_closed") {
				scheduleSync();
			}
		},
		[
			setThreadsMap,
			setThreadMessagesMap,
			setMessageToThreadMap,
			addTypingUser,
			clearTyping,
			onTokenExpiring,
			onTokenExpired,
			token,
		],
	);

	useSse(token, handler);
}
```

Key changes:
1. Added `onTokenExpiring` and `onTokenExpired` to params
2. Added `token_expiring` handler that calls `onTokenExpiring(token)`
3. Added `token_expired` handler that calls `onTokenExpired()`
4. Added `token` to the callback dependency array (used in `token_expiring` handler)
5. Added `onTokenExpiring` and `onTokenExpired` to dependency array

- [ ] **Step 2: Run lint and build**

```bash
cd frontend && npx biome check src/hooks/useSseEvents.ts && npm run build
```
Expected: no errors (build errors expected if useChatInteraction not yet updated — that's fine)

---

### Task 6: useChatInteraction.ts — Wire up token expiry handlers

**File:** `frontend/src/hooks/useChatInteraction.ts`

- [ ] **Step 1: Find the `useSseEvents` call and add new props**

Search for `useSseEvents({` in the file (it's called with current props). Add `onTokenExpiring` and `onTokenExpired`.

`onTokenExpiring` should:
1. Call `refreshToken(token)` 
2. Call `updateAccountToken(token, newToken, newExpiresAt)` from `useAuth`

`onTokenExpired` should:
1. Call `logout()` from `useAuth` (which removes the active account)

Find the block that destructures from useAuth and add `updateAccountToken`:
```ts
const { activeAccount, logout, updateAccountToken } = useAuth();
```

Find the `useSseEvents` call and add:
```ts
useSseEvents({
	token,
	setThreadsMap,
	setThreadMessagesMap,
	setMessageToThreadMap,
	addTypingUser,
	clearTyping,
	onTokenExpiring: async (currentToken: string) => {
		try {
			const { token: newToken, expiresAt } = await refreshToken(currentToken);
			updateAccountToken(currentToken, newToken, expiresAt);
		} catch {
			logout();
		}
	},
	onTokenExpired: () => {
		logout();
	},
});
```

Exact changes needed can't be shown here without reading the full file — make the changes matching the existing code structure. The key is:
1. Destructure `updateAccountToken` from `useAuth()`
2. Pass `onTokenExpiring` that calls `refreshToken` then `updateAccountToken`
3. Pass `onTokenExpired` that calls `logout`

- [ ] **Step 2: Run lint and build**

```bash
cd frontend && npm run build
```
Expected: no errors

---

### Task 7: LoginPage.tsx — Rewrite with 3-step email auth form

**File:** `frontend/src/pages/LoginPage.tsx`

- [ ] **Step 1: Replace the entire file content**

```tsx
import {
	Button,
	Center,
	Paper,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { sendCode, verifyCode, completeRegistration } from "../api.ts";
import { useAuth } from "../useAuth.tsx";

type Step = "email" | "code" | "nick";

export function LoginPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { addAccount, activeAccount } = useAuth();

	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [nick, setNick] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	if (activeAccount !== null) {
		return <Navigate to="/chat" />;
	}

	async function handleSendCode() {
		const trimmed = email.trim().toLowerCase();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		try {
			await sendCode(trimmed);
			setStep("code");
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.sendCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleVerifyCode() {
		const trimmed = code.trim();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		try {
			const result = await verifyCode(email.trim().toLowerCase(), trimmed);
			if (!result.isNew) {
				addAccount(result.token, result.user, email.trim().toLowerCase(), result.expiresAt);
				navigate({ to: "/chat" });
			} else {
				setSetupToken(result.setupToken);
				setStep("nick");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.verifyCode"));
		} finally {
			setLoading(false);
		}
	}

	async function handleCompleteRegistration() {
		const trimmed = nick.trim();
		if (trimmed.length === 0) return;
		setLoading(true);
		setError("");
		try {
			const result = await completeRegistration(setupToken, trimmed);
			addAccount(result.token, result.user, email.trim().toLowerCase(), result.expiresAt);
			navigate({ to: "/chat" });
		} catch (err) {
			setError(err instanceof Error ? err.message : t("error.register"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<Center className="h-full">
			<Paper withBorder p="xl" className="w-80">
				<div className="flex flex-col gap-4">
					<Title order={1} ta="center" c="blue">
						{t("login.title")}
					</Title>
					<Text ta="center" size="sm" c="dimmed">
						{t("login.subtitle")}
					</Text>

					{step === "email" && (
						<>
							<TextInput
								placeholder={t("login.email")}
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
							<Button
								disabled={loading || email.trim().length === 0}
								loading={loading}
								onClick={handleSendCode}
							>
								{t("login.sendCode")}
							</Button>
						</>
					)}

					{step === "code" && (
						<>
							<Text size="sm" c="dimmed" ta="center">
								{t("login.codeSent", { email: email.trim().toLowerCase() })}
							</Text>
							<TextInput
								placeholder={t("login.code")}
								maxLength={6}
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
							<Button
								disabled={loading || code.trim().length < 6}
								loading={loading}
								onClick={handleVerifyCode}
							>
								{t("login.verify")}
							</Button>
						</>
					)}

					{step === "nick" && (
						<>
							<Text size="sm" c="dimmed" ta="center">
								{t("login.chooseNick")}
							</Text>
							<TextInput
								placeholder={t("login.nick")}
								maxLength={20}
								value={nick}
								onChange={(e) => setNick(e.target.value)}
								autoFocus
							/>
							{error.length > 0 && (
								<Text size="sm" c="red" ta="center">
									{error}
								</Text>
							)}
							<Button
								disabled={loading || nick.trim().length === 0}
								loading={loading}
								onClick={handleCompleteRegistration}
							>
								{t("login.join")}
							</Button>
						</>
					)}
				</div>
			</Paper>
		</Center>
	);
}
```

- [ ] **Step 2: Run lint and build**

```bash
cd frontend && npx biome check src/pages/LoginPage.tsx && npm run build
```
Expected: no errors

---

### Task 8: Add i18n translations

**File:** `frontend/src/i18n.ts` or translation files

- [ ] **Step 1: Find the translation file**

```bash
rg "login\.title" /home/ilya/Projects/fast_chat_go_react/frontend/src --files-with-matches
```

- [ ] **Step 2: Add new translation keys for the login flow**

Add to the `login` section:
```
login.email: "Email"
login.sendCode: "Send Code"
login.code: "Verification code"
login.codeSent: "A code has been sent to {{email}}"
login.verify: "Verify"
login.chooseNick: "Choose your nickname"
```

Add to the `error` section:
```
error.sendCode: "Failed to send code"
error.verifyCode: "Invalid or expired code"
```

The exact file depends on how i18n is set up — check the translation file structure and add accordingly.

- [ ] **Step 3: Run lint and build**

```bash
cd frontend && npm run build
```
Expected: no errors

---

### Task 9: Final verification

- [ ] **Step 1: Full TypeScript check**

```bash
cd frontend && tsc -b
```
Expected: no errors

- [ ] **Step 2: Biome lint**

```bash
cd frontend && npx biome check src/
```
Expected: no errors in modified files

- [ ] **Step 3: Production build**

```bash
cd frontend && npm run build
```
Expected: build succeeds

- [ ] **Step 4: Backend build (verify no regressions)**

```bash
cd backend && go build ./... && go vet ./...
```
Expected: no errors
