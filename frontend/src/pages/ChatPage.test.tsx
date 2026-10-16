import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import type { Chat } from "../types/api.ts";
import { AuthProvider } from "../useAuth.tsx";
import { ChatPage } from "./ChatPage.tsx";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api.ts", () => ({
	getConfig: vi.fn(() =>
		Promise.resolve({ messageEditTTL: 60, messageDeleteTTL: 120 }),
	),
	getThreads: vi.fn(() => Promise.resolve({ threads: [] })),
	getThreadMessages: vi.fn(() => Promise.resolve({ messages: [] })),
	getMessages: vi.fn(() => Promise.resolve({ messages: [] })),
	searchUsers: vi.fn(() => Promise.resolve({ users: [] })),
	createChat: vi.fn(),
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
}));

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
	Virtuoso: ({ data }: { data: unknown[] }) => (
		<div data-testid="virtuoso">{data.length}</div>
	),
}));

vi.mock("../components/chat/AudioPlayerBar.tsx", () => ({
	AudioPlayerBar: () => null,
}));

const { useSse } = await import("../useSse.ts");

const SELECT_PROMPT = /selectPrompt|Select/;
const MEMBER_COUNT = /chat\.membersCount|member/;
const SETTINGS_LABEL = /Settings|chat\.settings/;

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

	it("picks a chat from URL params once", async () => {
		seedAccount();
		await chatsRepo.upsert(groupChat());
		window.history.replaceState({}, "", "/chat?chatId=c1");
		try {
			renderPage();

			await screen.findByText(MEMBER_COUNT);
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
