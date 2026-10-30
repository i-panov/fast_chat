import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api.ts", () => ({
	sseAuth: vi.fn(),
}));

const { sseAuth } = await import("./api.ts");
const { useSse } = await import("./useSse.ts");

type Listener = (e: { data: string }) => void;

const EVENTS_URL_PATTERN = /^\/api\/events\?connectionId=.+/;

class MockEventSource {
	static instances: MockEventSource[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 2;

	readyState = MockEventSource.OPEN;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	listeners = new Map<string, Listener[]>();

	constructor(public url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, cb: Listener) {
		const list = this.listeners.get(type) ?? [];
		list.push(cb);
		this.listeners.set(type, list);
	}

	close() {
		this.closed = true;
	}

	emit(type: string, data: unknown) {
		for (const cb of this.listeners.get(type) ?? []) {
			cb({ data: JSON.stringify(data) });
		}
	}

	emitRaw(type: string, data: string) {
		for (const cb of this.listeners.get(type) ?? []) {
			cb({ data });
		}
	}
}

function lastSource(): MockEventSource {
	const all = MockEventSource.instances;
	if (all.length === 0) throw new Error("no EventSource created");

	return all[all.length - 1];
}

function mockSseAuth() {
	return vi.mocked(sseAuth);
}

beforeEach(() => {
	MockEventSource.instances = [];
	vi.stubGlobal("EventSource", MockEventSource);
	vi.useFakeTimers();
	vi.clearAllMocks();
	mockSseAuth().mockResolvedValue({ status: "ok" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("useSse", () => {
	it("does not connect without a token", () => {
		renderHook(() => useSse("", vi.fn()));

		expect(MockEventSource.instances).toHaveLength(0);
	});

	it("opens the stream and authenticates it", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		expect(source.url).toMatch(EVENTS_URL_PATTERN);

		act(() => {
			source.onopen?.();
		});

		const connectionId = new URL(source.url, "http://x").searchParams.get(
			"connectionId",
		);
		expect(mockSseAuth()).toHaveBeenCalledWith(connectionId, "tok");
	});

	it("dispatches parsed JSON events", async () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().emit("new_message", { id: "m1" });
			lastSource().emitRaw("typing", "not-json{");
		});
		// The serialized dispatch runs on microtasks (fake timers stay
		// untouched): drain the queue and assert the settled calls.
		await act(async () => {});

		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onEvent).toHaveBeenCalledWith("new_message", { id: "m1" });
	});

	it("dispatches token lifecycle events", async () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().emit("token_expiring", { expiresIn: 60 });
			lastSource().emit("token_expired", {});
		});
		await act(async () => {});

		expect(onEvent).toHaveBeenCalledWith("token_expiring", {
			expiresIn: 60,
		});
		expect(onEvent).toHaveBeenCalledWith("token_expired", {});
	});

	it("dispatches data events strictly in arrival order", async () => {
		const order: string[] = [];
		const onEvent = vi.fn((event: string) => {
			order.push(event);
		});
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().emit("new_message", { id: "m1" });
			lastSource().emit("message_deleted", { messageId: "m1" });
		});
		await act(async () => {});

		expect(onEvent).toHaveBeenCalledTimes(2);
		expect(order).toEqual(["new_message", "message_deleted"]);
	});

	it("uses a fresh connectionId when the token changes", () => {
		const { rerender } = renderHook(({ token }) => useSse(token, vi.fn()), {
			initialProps: { token: "t1" },
		});
		const firstId = new URL(lastSource().url, "http://x").searchParams.get(
			"connectionId",
		);

		rerender({ token: "t2" });
		const secondId = new URL(lastSource().url, "http://x").searchParams.get(
			"connectionId",
		);

		expect(firstId).toBeTruthy();
		expect(secondId).toBeTruthy();
		expect(secondId).not.toBe(firstId);
	});

	it("emits connected and resets the backoff", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().emitRaw("connected", "{}");
		});

		expect(onEvent).toHaveBeenCalledWith("connected", null);
	});

	it("reconnects with backoff after the stream closes", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const first = lastSource();
		first.readyState = MockEventSource.CLOSED;
		act(() => {
			first.onerror?.();
		});

		expect(onEvent).toHaveBeenCalledWith("sse_closed", null);
		expect(MockEventSource.instances).toHaveLength(1);

		act(() => {
			vi.advanceTimersByTime(31_000);
		});

		expect(MockEventSource.instances).toHaveLength(2);
	});

	it("stays silent on transient errors while connecting", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		source.readyState = MockEventSource.CONNECTING;
		act(() => {
			source.onerror?.();
		});

		expect(onEvent).not.toHaveBeenCalled();
		expect(MockEventSource.instances).toHaveLength(1);
	});

	it("closes the stream and cancels reconnects on unmount", () => {
		renderHook(() => useSse("tok", vi.fn())).unmount();

		const source = lastSource();
		expect(source.closed).toBe(true);

		act(() => {
			vi.advanceTimersByTime(60_000);
		});

		expect(MockEventSource.instances).toHaveLength(1);
	});

	it("reopens the stream when the token changes", () => {
		const { rerender } = renderHook(({ token }) => useSse(token, vi.fn()), {
			initialProps: { token: "t1" },
		});

		rerender({ token: "t2" });

		expect(MockEventSource.instances).toHaveLength(2);
		expect(MockEventSource.instances[0].closed).toBe(true);
	});

	it("treats throwing readyState as closed", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		Object.defineProperty(source, "readyState", {
			get: () => {
				throw new Error("nope");
			},
			configurable: true,
		});
		act(() => {
			source.onerror?.();
		});

		expect(onEvent).toHaveBeenCalledWith("sse_closed", null);
	});

	it("surfaces unexpected errors", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		source.readyState = MockEventSource.OPEN;
		act(() => {
			source.onerror?.();
		});

		expect(onEvent).toHaveBeenCalledWith("error", null);
	});

	it("ignores events from a superseded socket", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const first = lastSource();
		first.readyState = MockEventSource.CLOSED;
		act(() => {
			first.onerror?.();
		});
		act(() => {
			vi.advanceTimersByTime(31_000);
		});
		expect(MockEventSource.instances).toHaveLength(2);

		onEvent.mockClear();
		act(() => {
			first.emitRaw("connected", "{}");
			first.onerror?.();
		});

		expect(onEvent).not.toHaveBeenCalled();
	});

	// A stream that is open but not authenticated delivers nothing and
	// reports no error, so the authentication has to be retried here.
	it("retries the authentication when the first attempt fails", async () => {
		mockSseAuth().mockRejectedValueOnce(new Error("down"));
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().onopen?.();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
		});

		expect(mockSseAuth()).toHaveBeenCalledTimes(2);
		expect(MockEventSource.instances).toHaveLength(1);
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("closes the stream when the authentication keeps failing", async () => {
		mockSseAuth().mockRejectedValue(new Error("down"));
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		act(() => {
			source.onopen?.();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(source.closed).toBe(true);
		expect(onEvent).toHaveBeenCalledWith("sse_closed", null);
	});

	it("does not retry an expired session", async () => {
		mockSseAuth().mockRejectedValue(new Error("unauthorized"));
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().onopen?.();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4000);
		});

		expect(mockSseAuth()).toHaveBeenCalledTimes(1);
	});

	it("ignores errors after teardown", () => {
		const onEvent = vi.fn();
		const { unmount } = renderHook(() => useSse("tok", onEvent));

		const source = lastSource();
		unmount();
		source.readyState = MockEventSource.CLOSED;
		act(() => {
			source.onerror?.();
		});

		expect(onEvent).not.toHaveBeenCalled();
		expect(MockEventSource.instances).toHaveLength(1);
	});
});
