import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import type { Message } from "../types/api.ts";

vi.mock("../api.ts", () => ({
	markMessagesRead: vi.fn(),
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

const { markMessagesRead } = await import("../api.ts");
const { useMessageReadStatuses } = await import("./useMessageReadStatuses.ts");

function msg(id: string): Message {
	return {
		id,
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: `text ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function mockMark() {
	return vi.mocked(markMessagesRead);
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	mockMark().mockResolvedValue({ status: "ok" });
});

describe("useMessageReadStatuses", () => {
	it("flushes a batch after the debounce", async () => {
		await messagesRepo.upsertMany([msg("m1"), msg("m2")]);
		const { result } = renderHook(() =>
			useMessageReadStatuses({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.markVisibleAsRead(["m1", "m2"]);
		});
		expect(mockMark()).not.toHaveBeenCalled();

		await waitFor(() => {
			expect(mockMark()).toHaveBeenCalledWith("tok", "c1", ["m1", "m2"]);
		});
		expect((await messagesRepo.getById("c1", "m1"))?.deliveryStatus).toBe(
			"read",
		);
	});

	it("marks thread messages in thread mode", async () => {
		await threadMessagesRepo.upsert(msg("tm1"), "th1");
		const { result } = renderHook(() =>
			useMessageReadStatuses({ token: "tok", chatId: "c1", isInThread: true }),
		);

		act(() => {
			result.current.markVisibleAsRead(["tm1"]);
		});

		await waitFor(async () => {
			expect(
				(await threadMessagesRepo.getById("th1", "tm1"))?.deliveryStatus,
			).toBe("read");
		});
	});

	it("flushes immediately at the batch limit", async () => {
		const { result } = renderHook(() =>
			useMessageReadStatuses({ token: "tok", chatId: "c1" }),
		);
		const ids = Array.from({ length: 51 }, (_, i) => `m${i}`);

		act(() => {
			result.current.markVisibleAsRead(ids);
		});

		await waitFor(() => {
			expect(mockMark()).toHaveBeenCalledTimes(1);
		});
		expect(mockMark().mock.calls[0][2]).toHaveLength(50);
	});

	it("requeues on failure and backs off after 429", async () => {
		mockMark().mockRejectedValueOnce(new Error("429 retry-after:1"));
		const { result } = renderHook(() =>
			useMessageReadStatuses({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.markVisibleAsRead(["m1"]);
		});

		await waitFor(() => {
			expect(mockMark()).toHaveBeenCalledTimes(1);
		});

		// Backoff active: a plain debounce window is not enough for the retry.
		mockMark().mockResolvedValue({ status: "ok" });
		act(() => {
			result.current.markVisibleAsRead(["m2"]);
		});
		await new Promise((r) => setTimeout(r, 500));
		expect(mockMark()).toHaveBeenCalledTimes(1);

		await waitFor(
			() => {
				expect(mockMark()).toHaveBeenCalledTimes(2);
			},
			{ timeout: 3000 },
		);
	});

	it("ignores calls without an identity", () => {
		const { result } = renderHook(() =>
			useMessageReadStatuses({ token: undefined, chatId: null }),
		);

		act(() => {
			result.current.markVisibleAsRead(["m1"]);
		});

		expect(mockMark()).not.toHaveBeenCalled();
	});

	it("drops the pending flush on unmount", async () => {
		const { result, unmount } = renderHook(() =>
			useMessageReadStatuses({ token: "tok", chatId: "c1" }),
		);

		act(() => {
			result.current.markVisibleAsRead(["m1"]);
		});
		unmount();

		await new Promise((r) => setTimeout(r, 500));
		expect(mockMark()).not.toHaveBeenCalled();
	});
});
