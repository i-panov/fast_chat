/* eslint-disable max-lines -- the page test covers layout, presence, calls and routing. */
import { MantineProvider } from "@mantine/core";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import i18n from "../i18n.ts";
import type { Chat } from "../types/api.ts";
import { AuthProvider } from "../useAuth.tsx";
import { ChatPage } from "./ChatPage.tsx";

const navigate = vi.hoisted(() => vi.fn());
const media = vi.hoisted(() => ({ mobile: false }));

vi.mock("@mantine/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mantine/hooks")>();
	return { ...actual, useMediaQuery: () => media.mobile };
});

const startCall = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ callId: "c-1", state: "ringing" })),
);

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigate,
		useRouterState: () => "/chat",
		useSearch: () => undefined,
	};
});

// The real module supplies ApiError: the call hook tells the refusals of the
// server by the type of the error, and a mock without the class would crash
// on the check instead of showing the notification.
vi.mock("../api.ts", async (importOriginal) => {
	const { ApiError } = await importOriginal<typeof import("../api.ts")>();

	return {
		ApiError,
		getConfig: vi.fn(() =>
			Promise.resolve({ messageEditTTL: 60, messageDeleteTTL: 120 }),
		),
		getThreads: vi.fn(() => Promise.resolve({ threads: [] })),
		getThreadMessages: vi.fn(() => Promise.resolve({ messages: [] })),
		getMessages: vi.fn(() => Promise.resolve({ messages: [] })),
		searchUsers: vi.fn(() => Promise.resolve({ users: [] })),
		createChat: vi.fn(),
		deleteChat: vi.fn(() => Promise.resolve({ status: "ok" })),
		refreshToken: vi.fn(),
		uploadPublicKey: vi.fn(),
		getPublicKey: vi.fn(),
		getKeyBackup: vi.fn(() => {
			throw new Error("http 404: no key backup");
		}),
		setKeyBackup: vi.fn(),
		deleteKeyBackup: vi.fn(),
		revokeSession: vi.fn(() => Promise.resolve()),
		getIceServers: vi.fn(() => Promise.resolve({ stun: [], turn: [] })),
		startCall,
		acceptCall: vi.fn(() =>
			Promise.resolve({ callId: "c-1", state: "active" }),
		),
		rejectCall: vi.fn(() => Promise.resolve({ status: "ok" })),
		hangupCall: vi.fn(() => Promise.resolve({ status: "ok" })),
		hangupCallOnLeave: vi.fn(() => Promise.resolve({ status: "ok" })),
		sendCallIce: vi.fn(() => Promise.resolve({ status: "ok" })),
		getCurrentCall: vi.fn(() => Promise.reject(new Error("http 404"))),
	};
});

vi.mock("../useSse.ts", () => ({
	useSse: vi.fn(),
}));

vi.mock("../sync/syncEngine.ts", () => ({
	setTokenProvider: vi.fn(),
	retryFailedOps: vi.fn(async () => {}),
	scheduleSync: vi.fn(),
	getSyncState: () => "idle" as const,
	subscribeSyncState: () => () => {},
}));

vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
	}: {
		data: unknown[];
		itemContent: (index: number, entry: unknown) => React.ReactNode;
	}) => (
		<div data-testid="virtuoso">
			{data.map((entry, i) => {
				const key =
					typeof entry === "object" &&
					entry !== null &&
					"key" in entry &&
					typeof entry.key === "string"
						? entry.key
						: i;
				return (
					<div key={key} data-item-index={i}>
						{itemContent(i, entry)}
					</div>
				);
			})}
		</div>
	),
}));

vi.mock("../components/chat/AudioPlayerBar.tsx", () => ({
	AudioPlayerBar: () => null,
}));

const { useSse } = await import("../useSse.ts");
const { refreshToken } = await import("../api.ts");
const { retryFailedOps, setTokenProvider } = await import(
	"../sync/syncEngine.ts"
);

type SseHandler = (event: string, data: unknown) => Promise<void> | void;

function sseHandler(): SseHandler {
	const calls = vi.mocked(useSse).mock.calls;
	if (calls.length === 0) throw new Error("useSse was not called");

	return calls[calls.length - 1][1];
}

const SELECT_PROMPT = /selectPrompt|Select/;
const BACK_BUTTON_RE = /chat\.back|Back|Назад/;
const ROOT_BOT_RE = /Root Bot/;
const BOB_BUTTON_RE = /bob/;
const DELETE_CHAT_RE = /Delete chat|Удалить чат/;
const DELETE_CONFIRM_RE = /Delete the chat|Удалить чат «/;
// biome-ignore lint/security/noSecrets: a DOM selector, not a secret
const DIALOG_SELECTOR = '[role="dialog"]';
const CALL_BUTTON_RE = /call\.start|Call/;
const FIND_OPTIONS = { timeout: 5000 };
const MEMBER_COUNT = /chat\.membersCount|member/;
const SETTINGS_LABEL = /Settings|chat\.settings/;
const CALL_LABEL = /call\.start|Call/;
const ACCEPT_LABEL = /call\.accept|Accept/;

type SwListener = (e: { data: unknown }) => void;

const swListeners: SwListener[] = [];

function stubServiceWorker() {
	Object.defineProperty(navigator, "serviceWorker", {
		value: {
			addEventListener: (_type: string, cb: SwListener) => {
				swListeners.push(cb);
			},
			removeEventListener: (_type: string, cb: SwListener) => {
				const i = swListeners.indexOf(cb);
				if (i >= 0) swListeners.splice(i, 1);
			},
		},
		configurable: true,
	});
}

function seedAccount() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "tok",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "tok");
	setActiveAccountKey("alice:test");
}

function groupChat(): Chat {
	return {
		id: "c1",
		type: "group",
		name: "Team",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice", online: true },
			{ id: "bob:test", nick: "bob" },
		],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function privateChat(): Chat {
	return {
		id: "c2",
		type: "private",
		name: "",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice", online: true },
			{ id: "bob:test", nick: "bob", online: true },
		],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function botChat(): Chat {
	return {
		id: "cb1",
		type: "private",
		name: "",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice", online: true },
			{
				id: "root_bot:test",
				nick: "Root Bot",
				username: "root_bot",
				isBot: true,
				online: true,
			},
		],
		createdAt: "2026-01-01T00:00:00Z",
		isBotChat: true,
		botEncryptionMode: "server",
	};
}

// favoritesChat is the chat with the user alone: there is nobody to call.
function favoritesChat(): Chat {
	return {
		id: "c3",
		type: "self",
		name: "",
		ownerId: "alice:test",
		members: [{ id: "alice:test", nick: "alice", online: true }],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

// stubCallMedia gives the manager a camera and a connection: jsdom has
// neither.
function stubCallMedia() {
	// Only the media is replaced: the rest of the navigator is used by the
	// components of the page.
	Object.defineProperty(navigator, "mediaDevices", {
		value: {
			getUserMedia: vi.fn().mockResolvedValue({
				getTracks: () => [{ stop: vi.fn() }],
				getAudioTracks: () => [],
				getVideoTracks: () => [],
			}),
		},
		configurable: true,
	});

	vi.stubGlobal(
		"RTCPeerConnection",
		class {
			createOffer() {
				return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
			}

			setLocalDescription() {
				return Promise.resolve();
			}

			addTrack() {}

			close() {}
		},
	);
}

function renderPage() {
	return render(
		<MantineProvider>
			<AuthProvider>
				<ChatPage />
			</AuthProvider>
		</MantineProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	swListeners.length = 0;
	vi.clearAllMocks();
	stubServiceWorker();
	// jsdom has no FontFaceSet; Mantine's autosize Textarea needs it.
	Object.defineProperty(document, "fonts", {
		value: { addEventListener: () => {}, removeEventListener: () => {} },
		configurable: true,
	});
});

describe("chat page", () => {
	it("renders nothing without an account", () => {
		const { container } = renderPage();

		expect(container.querySelector("header")).toBeNull();
	});

	it("prompts to select a chat", async () => {
		seedAccount();
		renderPage();

		expect(await screen.findByText(SELECT_PROMPT)).toBeTruthy();
		// The lifecycle wires the SSE stream with the session token.
		expect(useSse).toHaveBeenCalledWith("tok", expect.any(Function));
	});

	it("opens a chat from the list", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		renderPage();

		await screen.findByText("Team");
		fireEvent.click(screen.getByText("Team"));

		// Group header with the member count.
		await waitFor(() => {
			const headers = [...document.querySelectorAll("header")];
			if (!headers.some((h) => h.textContent?.includes("Team"))) {
				throw new Error("active header missing");
			}
		});
	});

	it("shows one pane on a phone and returns to the list", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		media.mobile = true;

		try {
			renderPage();

			// Only the list is visible; the empty-chat pane is not squeezed
			// next to a 300px sidebar.
			await screen.findByText("Team");
			expect(screen.queryByText(SELECT_PROMPT)).toBeNull();

			fireEvent.click(screen.getByText("Team"));

			await waitFor(() => {
				const headers = [...document.querySelectorAll("header")];
				if (!headers.some((h) => h.textContent?.includes("Team"))) {
					throw new Error("active header missing");
				}
			});
			const back = await screen.findByRole("button", { name: BACK_BUTTON_RE });
			fireEvent.click(back);

			await waitFor(() => {
				expect(
					screen.queryByRole("button", { name: BACK_BUTTON_RE }),
				).toBeNull();
			});
			expect(await screen.findByText("Team")).toBeTruthy();
		} finally {
			media.mobile = false;
		}
	});

	it("shows the bot username and no call button", async () => {
		seedAccount();
		await chatsRepo.upsert(botChat());
		renderPage();

		fireEvent.click(await screen.findByText(ROOT_BOT_RE));

		expect(await screen.findByText("@root_bot")).toBeTruthy();
		expect(screen.queryByRole("button", { name: CALL_BUTTON_RE })).toBeNull();
	});

	it("falls back to the display name for a bot without a username", async () => {
		seedAccount();
		// Both wire shapes reach the client: a federated member without the
		// field at all, and the backend's empty string for remote users.
		await chatsRepo.upsert({
			...botChat(),
			id: "cb2",
			members: [
				{ id: "alice:test", nick: "alice", online: true },
				{
					id: "remote_bot:peer.test",
					nick: "Remote Bot",
					isBot: true,
				},
			],
		});
		await chatsRepo.upsert({
			...botChat(),
			id: "cb4",
			members: [
				{ id: "alice:test", nick: "alice", online: true },
				{
					id: "empty_bot:peer.test",
					nick: "Empty Bot",
					username: "",
					isBot: true,
				},
			],
		});
		renderPage();

		// Assert on the active chat header specifically: the sidebar row
		// would render the display name even while the header is broken.
		for (const [row, handle] of [
			["Remote Bot", "@Remote Bot"],
			["Empty Bot", "@Empty Bot"],
		] as const) {
			fireEvent.click(await screen.findByText(row));
			const header = document.querySelector("main header");
			if (header === null) throw new Error("chat header missing");
			await waitFor(() => {
				expect(header.textContent).toContain(handle);
			});
			expect(header.textContent).not.toContain("@undefined");
		}
	});

	it("starts a call from the chat header", async () => {
		seedAccount();
		stubCallMedia();
		await chatsRepo.upsert(privateChat());
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: BOB_BUTTON_RE }));

		fireEvent.click(await screen.findByRole("button", { name: CALL_LABEL }));

		await waitFor(() => {
			expect(startCall).toHaveBeenCalledWith("tok", "c2", "offer-sdp");
		});
	});

	it("hides the call button in the Favorites chat", async () => {
		seedAccount();
		await chatsRepo.upsert(favoritesChat());
		renderPage();

		const favorites = i18n.t("chat.favorites");
		const entries = await screen.findAllByText(favorites);
		fireEvent.click(entries[0]);

		// The header of the chat is rendered: the chat is open.
		await waitFor(() => {
			const headers = [...document.querySelectorAll("header")];
			if (!headers.some((h) => h.textContent?.includes(favorites))) {
				throw new Error("active header missing");
			}
		});

		expect(screen.queryByRole("button", { name: CALL_LABEL })).toBeNull();
	});

	it("opens the window of an incoming call", async () => {
		seedAccount();
		renderPage();

		const handler = sseHandler();

		await act(async () => {
			await handler("call_incoming", {
				callId: "c-2",
				chatId: "chat-2",
				offer: "offer-sdp",
				from: { id: "bob:test", nick: "bob" },
			});
		});

		expect(
			await screen.findByRole("button", { name: ACCEPT_LABEL }),
		).toBeTruthy();
	});

	it("navigates on service-worker messages", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		renderPage();

		await screen.findByText("Team");
		for (const cb of [...swListeners]) {
			cb({ data: { type: "NAVIGATE_TO_CHAT", chatId: "c1" } });
		}

		await waitFor(() => {
			const headers = [...document.querySelectorAll("header")];
			if (!headers.some((h) => h.textContent?.includes("Team"))) {
				throw new Error("active header missing");
			}
		});
	});

	it("ignores unrelated worker messages", async () => {
		seedAccount();
		renderPage();

		await screen.findByText(SELECT_PROMPT);
		for (const cb of [...swListeners]) {
			cb({ data: { type: "OTHER" } });
			cb({ data: { type: "NAVIGATE_TO_CHAT" } });
		}

		expect(screen.queryByText("Team")).toBeNull();
	});

	it("deletes a chat from its context menu", async () => {
		seedAccount();
		await chatsRepo.upsert(privateChat());
		renderPage();

		fireEvent.contextMenu(
			await screen.findByRole("button", { name: BOB_BUTTON_RE }),
		);
		fireEvent.click(await screen.findByText(DELETE_CHAT_RE));

		const confirmText = await screen.findByText(DELETE_CONFIRM_RE);
		const dialog = confirmText.closest(DIALOG_SELECTOR);
		if (dialog === null) throw new Error("delete dialog not found");
		fireEvent.click(
			within(dialog as HTMLElement).getByRole("button", {
				name: DELETE_CHAT_RE,
			}),
		);

		const { deleteChat } = await import("../api.ts");
		await waitFor(() => {
			expect(deleteChat).toHaveBeenCalledWith("tok", "c2");
		});
	});

	it("picks a chat from URL params once", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		window.history.replaceState({}, "", "/chat?chatId=c1");
		try {
			renderPage();

			expect(await screen.findAllByText(MEMBER_COUNT)).not.toHaveLength(0);
			expect(window.location.search).toBe("");
		} finally {
			window.history.replaceState({}, "", "/");
		}
	});

	it("starts a pending chat from search", async () => {
		seedAccount();
		const { searchUsers } = await import("../api.ts");
		vi.mocked(searchUsers).mockResolvedValue({
			users: [{ id: "carol:test", nick: "carol", online: false }],
		});
		renderPage();

		const search = [...document.querySelectorAll("input")].find((el) =>
			el.getAttribute("placeholder")?.includes("earch"),
		);
		if (!(search instanceof HTMLInputElement)) throw new Error("no search box");
		fireEvent.change(search, { target: { value: "car" } });

		await screen.findByText("@carol");
		fireEvent.click(screen.getByText("@carol"));

		// Pending-chat header shows the recipient.
		await waitFor(() => {
			const headers = [...document.querySelectorAll("header")];
			if (!headers.some((h) => h.textContent?.includes("@carol"))) {
				throw new Error("pending header missing");
			}
		});
	});

	it("provides the session token to sync", async () => {
		seedAccount();
		renderPage();

		await screen.findByText(SELECT_PROMPT, undefined, FIND_OPTIONS);
		expect(vi.mocked(setTokenProvider)).toHaveBeenCalled();
	});

	it("refreshes an expiring token", async () => {
		seedAccount();
		vi.mocked(refreshToken).mockResolvedValue({
			token: "new-tok",
			expiresAt: "2028-01-01T00:00:00Z",
		});
		renderPage();

		await screen.findByText(SELECT_PROMPT, undefined, FIND_OPTIONS);
		await sseHandler()("token_expiring", {});

		await waitFor(() => {
			expect(localStorage.getItem("accounts")).toContain("new-tok");
		});
	});

	it("keeps the account when a token refresh fails transiently", async () => {
		seedAccount();
		vi.mocked(refreshToken).mockRejectedValueOnce(new Error("network"));
		renderPage();

		await screen.findByText(SELECT_PROMPT, undefined, FIND_OPTIONS);
		await sseHandler()("token_expiring", {});

		await waitFor(() => {
			expect(localStorage.getItem("accounts")).toContain("tok");
		});
	});

	it("drops the dead session when the token expires", async () => {
		seedAccount();
		renderPage();

		await screen.findByText(SELECT_PROMPT, undefined, FIND_OPTIONS);
		await sseHandler()("token_expired", {});

		await waitFor(() => {
			expect(localStorage.getItem("accounts")).toBe("[]");
		});
	});

	it("retries failed ops when back online", async () => {
		seedAccount();
		renderPage();

		await screen.findByText(SELECT_PROMPT, undefined, FIND_OPTIONS);
		window.dispatchEvent(new Event("online"));

		await waitFor(() => {
			expect(vi.mocked(retryFailedOps)).toHaveBeenCalled();
		});
	});

	it("opens and closes a thread", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		const { threadsRepo } = await import("../db/threadsRepo.ts");
		const { threadMessagesRepo } = await import("../db/threadMessagesRepo.ts");
		await threadsRepo.upsert({
			id: "th1",
			chatId: "c1",
			parentMessageId: "p1",
			parentMessageText: "parent text",
			parentMessageFrom: "bob",
			createdAt: "2026-01-01T00:00:00Z",
			messageCount: 1,
		});
		await messagesRepo.upsert({
			id: "p1",
			chatId: "c1",
			fromId: "bob:test",
			fromNick: "bob",
			text: "parent text",
			createdAt: "2026-01-01T00:00:00Z",
		});
		const { getThreadMessages } = await import("../api.ts");
		vi.mocked(getThreadMessages).mockResolvedValue({
			messages: [
				{
					id: "tm1",
					chatId: "c1",
					fromId: "bob:test",
					fromNick: "bob",
					text: "in thread",
					createdAt: "2026-01-01T00:00:01Z",
				},
			],
		});
		renderPage();

		await screen.findByText("Team");
		fireEvent.click(screen.getByText("Team"));

		// Thread link on the parent message.
		const link = await screen.findByText("1");
		fireEvent.click(link);

		await screen.findByText("parent text", { selector: "p" });
		expect(await threadMessagesRepo.getByThread("th1")).not.toEqual([]);

		// Back to the chat.
		const back = document.querySelectorAll("button")[0];
		fireEvent.click(back);

		await waitFor(() => {
			expect(document.body.textContent).toContain("Team");
		});
	});

	it("opens group settings from the header", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		renderPage();

		await screen.findByText("Team");
		fireEvent.click(screen.getByText("Team"));

		const settings = await screen.findByLabelText(SETTINGS_LABEL);
		fireEvent.click(settings);

		await waitFor(() => {
			expect([...document.querySelectorAll("input")].length).toBeGreaterThan(0);
		});
	});
});
