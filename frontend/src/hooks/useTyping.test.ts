import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.ts", () => ({
	sendTyping: vi.fn(),
}));

const { sendTyping } = await import("../api.ts");
const { useTyping } = await import("./useTyping.ts");

function mockSendTyping() {
	return vi.mocked(sendTyping);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mockSendTyping().mockResolvedValue({ status: "ok" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useTyping", () => {
	it("does nothing without a token", () => {
		const { result } = renderHook(() => useTyping({ token: undefined }));

		act(() => {
			result.current.handleTyping("c1", true);
		});

		expect(mockSendTyping()).not.toHaveBeenCalled();
	});

	it("sends typing state and throttles repeats", () => {
		const { result } = renderHook(() => useTyping({ token: "tok" }));

		act(() => {
			result.current.handleTyping("c1", true);
			result.current.handleTyping("c1", true);
		});
		expect(mockSendTyping()).toHaveBeenCalledTimes(1);
		expect(mockSendTyping()).toHaveBeenCalledWith("tok", "c1", true);

		act(() => {
			vi.setSystemTime(Date.now() + 2001);
			result.current.handleTyping("c1", true);
		});
		expect(mockSendTyping()).toHaveBeenCalledTimes(2);
	});

	it("always sends the stopped state", () => {
		const { result } = renderHook(() => useTyping({ token: "tok" }));

		act(() => {
			result.current.handleTyping("c1", false);
			result.current.handleTyping("c1", false);
		});

		expect(mockSendTyping()).toHaveBeenCalledTimes(2);
	});

	it("swallows send failures", async () => {
		mockSendTyping().mockRejectedValueOnce(new Error("down"));
		const { result } = renderHook(() => useTyping({ token: "tok" }));

		act(() => {
			result.current.handleTyping("c1", true);
		});
		await act(async () => {});

		expect(mockSendTyping()).toHaveBeenCalledTimes(1);
	});

	it("adds users without duplicates and auto-clears them", () => {
		const { result } = renderHook(() => useTyping({ token: "tok" }));
		const payload = { chatId: "c1", userId: "bob:test", nick: "bob" };

		act(() => {
			result.current.addTypingUser(payload);
			result.current.addTypingUser(payload);
		});
		expect(result.current.typingUsers).toEqual({ c1: [payload] });

		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(result.current.typingUsers).toEqual({});
	});

	it("clearTyping removes one user and keeps the rest", () => {
		const { result } = renderHook(() => useTyping({ token: "tok" }));

		act(() => {
			result.current.addTypingUser({ chatId: "c1", userId: "a", nick: "a" });
			result.current.addTypingUser({ chatId: "c1", userId: "b", nick: "b" });
			result.current.clearTyping("c1", "a");
		});

		expect(result.current.typingUsers.c1.map((t) => t.userId)).toEqual(["b"]);

		// The pending auto-clear for "a" was cancelled: advancing must not
		// drop "b" through a stale timer.
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(result.current.typingUsers).toEqual({});
	});

	it("clears all timers on unmount", () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		const { result, unmount } = renderHook(() => useTyping({ token: "tok" }));

		act(() => {
			result.current.addTypingUser({ chatId: "c1", userId: "a", nick: "a" });
		});
		unmount();

		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});
});
