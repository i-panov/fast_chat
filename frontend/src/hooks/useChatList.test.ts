import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import type { Chat } from "../types/api.ts";
import { useChatList } from "./useChatList.ts";

vi.mock("../sync/syncEngine.ts", () => ({
	scheduleSync: vi.fn(),
}));

function chat(id: string, name: string): Chat {
	return {
		id,
		type: "group",
		name,
		ownerId: "alice:test",
		members: [{ id: "alice:test", nick: "alice" }],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("useChatList", () => {
	it("loads the chats of the active account", async () => {
		await chatsRepo.upsert(chat("a1", "Alice chat"));

		const { result } = renderHook(() => useChatList({ token: "t1" }));

		await waitFor(() => {
			expect(result.current.chats.map((c) => c.id)).toEqual(["a1"]);
		});
	});

	it("drops the previous account's chats and selection on a switch", async () => {
		await chatsRepo.upsert(chat("a1", "Alice chat"));
		const { result } = renderHook(() => useChatList({ token: "t1" }));

		await waitFor(() => {
			expect(result.current.chats.map((c) => c.id)).toEqual(["a1"]);
		});
		act(() => {
			result.current.selectChat("a1");
		});
		expect(result.current.activeChatId).toBe("a1");

		await act(async () => {
			setActiveAccountKey("bob:test");
			await chatsRepo.upsert(chat("b1", "Bob chat"));
		});

		await waitFor(() => {
			expect(result.current.chats.map((c) => c.id)).toEqual(["b1"]);
		});
		// The chat of the previous account must not stay selected.
		expect(result.current.activeChatId).toBeNull();
	});

	it("never shows a snapshot read from another account", async () => {
		await chatsRepo.upsert(chat("a1", "Alice chat"));

		const { result, rerender } = renderHook(
			({ token }) => useChatList({ token }),
			{ initialProps: { token: "t1" } },
		);
		await waitFor(() => {
			expect(result.current.chats).toHaveLength(1);
		});

		// The switch re-renders the page before the new account has any
		// chats: the old list is not shown even for the intermediate frame.
		act(() => {
			setActiveAccountKey("bob:test");
		});
		rerender({ token: "t2" });

		expect(result.current.chats).toEqual([]);
	});
});
