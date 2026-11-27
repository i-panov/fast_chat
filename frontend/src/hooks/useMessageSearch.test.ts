import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.ts", () => ({
	searchUsers: vi.fn(),
}));

const { searchUsers } = await import("../api.ts");
const { useMessageSearch } = await import("./useMessageSearch.ts");

function mockSearchUsers() {
	return vi.mocked(searchUsers);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useMessageSearch", () => {
	it("clears results on empty input", () => {
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.handleSearchChange("   ");
		});

		expect(result.current.searchQuery).toBe("   ");
		expect(result.current.searchResults).toEqual([]);
		expect(result.current.showSearchResults).toBe(false);
		expect(mockSearchUsers()).not.toHaveBeenCalled();
	});

	it("debounces the lookup", async () => {
		mockSearchUsers().mockResolvedValue({ users: [] });
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.handleSearchChange("a");
			result.current.handleSearchChange("ab");
		});
		expect(mockSearchUsers()).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(300);
		});
		await act(async () => {});

		expect(mockSearchUsers()).toHaveBeenCalledTimes(1);
		expect(mockSearchUsers()).toHaveBeenCalledWith("tok", "ab");
		expect(result.current.searchResults).toEqual([]);
		expect(result.current.showSearchResults).toBe(true);
	});

	it("shows found users", async () => {
		const users = [{ id: "b:test", nick: "bob", online: true }];
		mockSearchUsers().mockResolvedValue({ users });
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.handleSearchChange("bob");
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		await act(async () => {});

		expect(result.current.searchResults).toEqual(users);
		expect(result.current.showSearchResults).toBe(true);
	});

	it("does not reopen stale results after the field is cleared", async () => {
		// A request that was already in flight passed the sequence check after
		// clearing and opened the dropdown with the old list.
		let resolveUsers: (v: {
			users: Array<{ id: string; nick: string; online: boolean }>;
		}) => void = () => {};
		mockSearchUsers().mockReturnValue(
			new Promise((resolve) => {
				resolveUsers = resolve;
			}),
		);
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.handleSearchChange("bob");
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});

		act(() => {
			result.current.handleSearchChange("");
		});
		await act(async () => {
			resolveUsers({ users: [{ id: "b:test", nick: "bob", online: true }] });
			await Promise.resolve();
		});

		expect(result.current.searchResults).toEqual([]);
		expect(result.current.showSearchResults).toBe(false);
	});

	it("clears results when the account token changes", () => {
		const users = [{ id: "b:test", nick: "bob", online: true }];
		mockSearchUsers().mockResolvedValue({ users });
		const { result, rerender } = renderHook(
			({ token }: { token: string | undefined }) => useMessageSearch(token),
			{ initialProps: { token: "tok" } },
		);

		act(() => {
			result.current.handleSearchChange("bob");
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});

		rerender({ token: "tok2" });

		expect(result.current.searchResults).toEqual([]);
		expect(result.current.searchQuery).toBe("");
	});

	it("hides results on lookup failure", async () => {
		mockSearchUsers().mockRejectedValueOnce(new Error("down"));
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.handleSearchChange("bob");
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		await act(async () => {});

		expect(result.current.showSearchResults).toBe(false);
	});

	it("skips the lookup without a token", async () => {
		const { result } = renderHook(() => useMessageSearch(undefined));

		act(() => {
			result.current.handleSearchChange("bob");
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});
		await act(async () => {});

		expect(mockSearchUsers()).not.toHaveBeenCalled();
	});

	it("selects and clears the pending chat", () => {
		const { result } = renderHook(() => useMessageSearch("tok"));

		act(() => {
			result.current.selectPendingChat("b:test", "bob");
		});
		expect(result.current.pendingChatWith).toBe("b:test");
		expect(result.current.pendingChatNick).toBe("bob");

		act(() => {
			result.current.clearPendingChat();
		});
		expect(result.current.pendingChatWith).toBeNull();
		expect(result.current.pendingChatNick).toBeNull();
	});
});
