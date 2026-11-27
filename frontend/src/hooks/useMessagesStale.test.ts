import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import type { StoredMessage } from "../db/schema.ts";

// The live query is the slow part of a chat switch: it still holds the
// previous chat's rows until the new IDB read lands. The hook must not render
// them under the new chat, so the query is pinned to the stale array here.
const staleRows: StoredMessage[] = [
	{
		id: "old-1",
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: "secret of the previous chat",
		createdAt: "2026-01-01T00:00:00Z",
		status: "sent",
		_updatedAt: "2026-01-01T00:00:00Z",
	},
];

vi.mock("../db/useLiveQuery.ts", () => ({
	useLiveQuery: () => staleRows,
}));

vi.mock("../api.ts", () => ({
	getMessages: vi.fn(() => Promise.resolve({ messages: [] })),
}));

vi.mock("../useAuth.tsx", () => ({
	useAuth: () => ({
		activeAccount: {
			user: { id: "alice:test", nick: "alice" },
			token: "tok",
			email: "a@example.com",
			expiresAt: "2027-01-01T00:00:00Z",
		},
	}),
}));

const { useMessages } = await import("./useMessages.ts");

beforeEach(() => {
	setActiveAccountKey("alice-stale-chat:test");
});

describe("useMessages stale live query", () => {
	it("does not render the previous chat's messages under a new chat", async () => {
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c2" }),
		);

		await waitFor(() => {
			expect(result.current.messages).toEqual([]);
		});
		expect(result.current.messages.some((m) => m.id === "old-1")).toBe(false);
	});
});
