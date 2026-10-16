import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { Message } from "../types/api.ts";
import { onNotification } from "../utils/notify.ts";

vi.mock("../api.ts", () => ({
	getMessages: vi.fn(),
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

const { getMessages } = await import("../api.ts");
const { useMessages } = await import("./useMessages.ts");

function msg(id: string, extra: Partial<Message> = {}): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: `text ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

function mockGetMessages() {
	return vi.mocked(getMessages);
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	mockGetMessages().mockResolvedValue({ messages: [] });
});

describe("useMessages", () => {
	it("returns nothing without a chat", () => {
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: null }),
		);

		expect(result.current.messages).toEqual([]);
		expect(result.current.hasMore).toBe(false);
	});

	it("skips deleted messages", async () => {
		await messagesRepo.upsertMany([msg("m1"), msg("m2")]);
		await messagesRepo.applyDelete("c1", "m1");
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.messages.map((m) => m.id)).toEqual(["m2"]);
		});
	});

	it("pages through the server history", async () => {
		mockGetMessages()
			.mockResolvedValueOnce({
				messages: [msg("m1")],
				nextCursor: "cur1",
			})
			.mockResolvedValueOnce({ messages: [msg("m2")] });
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.hasMore).toBe(true);
		});
		expect(mockGetMessages()).toHaveBeenCalledWith("tok", "c1", {
			limit: 30,
			before: undefined,
			missingIDs: [],
		});

		await act(async () => {
			await result.current.loadMore();
		});

		await waitFor(() => {
			expect(result.current.hasMore).toBe(false);
		});
		expect(mockGetMessages()).toHaveBeenLastCalledWith("tok", "c1", {
			limit: 30,
			before: "cur1",
			missingIDs: ["m1"],
		});
		await waitFor(() => {
			expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		});
	});

	it("stops paging at the known end", async () => {
		mockGetMessages().mockResolvedValue({ messages: [msg("m1")] });
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(mockGetMessages()).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(result.current.hasMore).toBe(false);
		});

		await act(async () => {
			await result.current.loadMore();
		});

		expect(mockGetMessages()).toHaveBeenCalledTimes(1);
	});

	it("goes offline instead of paging", async () => {
		mockGetMessages().mockResolvedValue({
			messages: [msg("m1")],
			nextCursor: "cur1",
		});
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.hasMore).toBe(true);
		});
		expect(mockGetMessages()).toHaveBeenCalledTimes(1);

		Object.defineProperty(window.navigator, "onLine", {
			value: false,
			configurable: true,
		});
		try {
			await act(async () => {
				await result.current.loadMore();
			});

			expect(result.current.hasMore).toBe(false);
			expect(mockGetMessages()).toHaveBeenCalledTimes(1);
		} finally {
			Object.defineProperty(window.navigator, "onLine", {
				value: true,
				configurable: true,
			});
		}
	});

	it("notifies when paging fails", async () => {
		mockGetMessages()
			.mockResolvedValueOnce({ messages: [msg("m1")], nextCursor: "c" })
			.mockRejectedValueOnce(new Error("down"));
		const seen: string[] = [];
		const off = onNotification((n) => seen.push(n.message));
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.hasMore).toBe(true);
		});
		await act(async () => {
			await result.current.loadMore();
		});

		await waitFor(() => {
			expect(seen).toHaveLength(1);
		});
		off();
	});

	it("evicts the decrypt cache past the limit", async () => {
		const many = Array.from({ length: 1005 }, (_, i) =>
			msg(`bulk-${i}`, {
				createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
			}),
		);
		await messagesRepo.upsertMany(many);
		const { result } = renderHook(() =>
			useMessages({ token: "tok", chatId: "c1" }),
		);

		await waitFor(() => {
			expect(result.current.messages.length).toBe(1005);
		});
	}, 30000);
});
