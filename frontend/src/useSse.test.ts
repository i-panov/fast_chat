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

	it("dispatches parsed JSON events", () => {
		const onEvent = vi.fn();
		renderHook(() => useSse("tok", onEvent));

		act(() => {
			lastSource().emit("new_message", { id: "m1" });
			lastSource().emitRaw("typing", "not-json{");
		});

		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(onEvent).toHaveBeenCalledWith("new_message", { id: "m1" });
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
});
