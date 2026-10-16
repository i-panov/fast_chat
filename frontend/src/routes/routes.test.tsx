import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen.ts";

vi.mock("../api.ts", () => ({
	sendCode: vi.fn(),
	verifyCode: vi.fn(),
	completeRegistration: vi.fn(),
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

const SELECT_PROMPT = /selectPrompt|Select/;

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
}

function renderAt(path: string) {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	render(<RouterProvider router={router} />);
	return router;
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
	Object.defineProperty(navigator, "serviceWorker", {
		value: { addEventListener: () => {}, removeEventListener: () => {} },
		configurable: true,
	});
	Object.defineProperty(document, "fonts", {
		value: { addEventListener: () => {}, removeEventListener: () => {} },
		configurable: true,
	});
});

describe("routes", () => {
	it("redirects anonymous visitors to login", async () => {
		renderAt("/chat");

		expect(await screen.findByDisplayValue("")).toBeTruthy();
	});

	it("serves the login page directly", async () => {
		renderAt("/login");

		expect(await screen.findByDisplayValue("")).toBeTruthy();
	});

	it("sends logged-in users from index to chat", async () => {
		seedAccount();
		renderAt("/");

		await screen.findByText(SELECT_PROMPT);
	});

	it("opens the chat page with a session", async () => {
		seedAccount();
		const router = renderAt("/chat");

		await screen.findByText(SELECT_PROMPT);
		expect(router.state.location.pathname).toBe("/chat");
	});

	it("logs in and lands on chat", async () => {
		const { sendCode, verifyCode } = await import("../api.ts");
		vi.mocked(sendCode).mockResolvedValue({ status: "ok" });
		vi.mocked(verifyCode).mockResolvedValue({
			isNew: false,
			user: { id: "a:test", nick: "alice", online: true },
			token: "tok",
			expiresAt: "2027-01-01T00:00:00Z",
		});
		renderAt("/login");

		const input = await screen.findByDisplayValue("");
		fireEvent.change(input, { target: { value: "a@example.com" } });
		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[buttons.length - 1]);

		const code = await screen.findByDisplayValue("");
		fireEvent.change(code, { target: { value: "123456" } });
		fireEvent.click(
			[...document.querySelectorAll("button")].pop() as HTMLButtonElement,
		);

		await screen.findByText(SELECT_PROMPT);
	});
});
