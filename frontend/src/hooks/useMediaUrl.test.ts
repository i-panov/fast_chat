import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaUrl } from "./useMediaUrl.ts";

const MEDIA_BYTES = new Uint8Array(100).map((_, i) => i % 256);

class ListenerSet {
	private map = new Map<string, Array<() => void>>();

	add(type: string, cb: () => void) {
		const list = this.map.get(type) ?? [];
		list.push(cb);
		this.map.set(type, list);
	}

	remove(type: string, cb: () => void) {
		this.map.set(
			type,
			(this.map.get(type) ?? []).filter((f) => f !== cb),
		);
	}

	emit(type: string) {
		for (const cb of this.map.get(type) ?? []) cb();
	}
}

class StubSourceBuffer {
	listeners = new ListenerSet();
	appended: ArrayBuffer[] = [];
	failNext = false;

	addEventListener(type: string, cb: () => void) {
		this.listeners.add(type, cb);
	}

	removeEventListener(type: string, cb: () => void) {
		this.listeners.remove(type, cb);
	}

	appendBuffer(data: ArrayBuffer) {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("append failed");
		}
		this.appended.push(data);
		queueMicrotask(() => {
			this.listeners.emit("updateend");
		});
	}

	emitError() {
		this.listeners.emit("error");
	}
}

class StubMediaSource {
	static instances: StubMediaSource[] = [];
	static isTypeSupported: (mime: string) => boolean = () => false;
	static failNextAppend = false;

	readyState = "closed";
	buffers: StubSourceBuffer[] = [];
	endOfStreamCalls = 0;
	listeners = new ListenerSet();

	constructor() {
		StubMediaSource.instances.push(this);
	}

	addEventListener(type: string, cb: () => void) {
		this.listeners.add(type, cb);
	}

	addSourceBuffer(_mime: string) {
		const sb = new StubSourceBuffer();
		if (StubMediaSource.failNextAppend) {
			StubMediaSource.failNextAppend = false;
			sb.failNext = true;
		}
		this.buffers.push(sb);
		return sb;
	}

	endOfStream() {
		this.endOfStreamCalls += 1;
	}

	emit(type: string) {
		this.readyState = "open";
		this.listeners.emit(type);
	}
}

let urlCounter = 0;
const revokeObjectURL = vi.fn();
const RANGE_PATTERN = /bytes=(\d+)-(\d+)/;

const requests: Array<{ method: string; headers: Headers }> = [];
let headHeaders = { "Content-Length": "100", "Content-Type": "video/mp4" };
let headFails = false;
let getFails = false;

function mockFetch() {
	return vi.fn((_url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({ method: init?.method ?? "GET", headers });
		if ((init?.method ?? "GET") === "HEAD") {
			if (headFails) return Promise.reject(new Error("head down"));
			return Promise.resolve(new Response(null, { headers: headHeaders }));
		}
		if (getFails) return Promise.reject(new Error("get down"));
		const range = headers.get("range");
		if (range) {
			const m = RANGE_PATTERN.exec(range);
			const start = Number(m?.[1] ?? 0);
			const end = Number(m?.[2] ?? MEDIA_BYTES.length - 1);
			const slice = MEDIA_BYTES.slice(start, end + 1);
			return Promise.resolve(new Response(slice.buffer, { status: 206 }));
		}
		return Promise.resolve(new Response(new Blob([MEDIA_BYTES])));
	});
}

beforeEach(() => {
	urlCounter = 0;
	requests.length = 0;
	headHeaders = { "Content-Length": "100", "Content-Type": "video/mp4" };
	headFails = false;
	getFails = false;
	StubMediaSource.instances = [];
	StubMediaSource.isTypeSupported = () => false;
	StubMediaSource.failNextAppend = false;
	vi.stubGlobal("MediaSource", StubMediaSource);
	vi.stubGlobal("fetch", mockFetch());
	URL.createObjectURL = vi.fn(() => `blob:mock-${urlCounter++}`);
	revokeObjectURL.mockClear();
	URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useMediaUrl", () => {
	it("stays idle without a URL or token", () => {
		const { result: noUrl } = renderHook(() => useMediaUrl(undefined, "tok"));
		expect(noUrl.current).toEqual({
			mediaUrl: null,
			loading: true,
			error: null,
		});

		const { result: noToken } = renderHook(() =>
			useMediaUrl("https://srv/v", undefined),
		);
		expect(noToken.current.mediaUrl).toBeNull();
	});

	it("passes blob URLs through", () => {
		const { result } = renderHook(() => useMediaUrl("blob:local", "tok"));

		expect(result.current.mediaUrl).toBe("blob:local");
		expect(result.current.loading).toBe(false);
	});

	it("falls back to a blob download for unsupported types", async () => {
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();

		const head = requests.find((r) => r.method === "HEAD");
		expect(head?.headers.get("authorization")).toBe("Bearer tok");
	});

	it("falls back to blob when HEAD fails", async () => {
		headFails = true;
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});
	});

	it("reports an error when the download fails", async () => {
		getFails = true;
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.error).toBeTruthy();
		});
		expect(result.current.loading).toBe(false);
		expect(result.current.mediaUrl).toBeNull();
	});

	it("streams supported media through MSE with range requests", async () => {
		StubMediaSource.isTypeSupported = (m) => m === "video/mp4";
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});

		const source = StubMediaSource.instances[0];
		act(() => {
			source.emit("sourceopen");
		});

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(source.buffers).toHaveLength(1);
		expect(source.buffers[0].appended).toHaveLength(1);
		expect(source.buffers[0].appended[0].byteLength).toBe(100);
		expect(source.endOfStreamCalls).toBe(1);

		const range = requests.find((r) => r.headers.has("range"));
		expect(range?.headers.get("range")).toBe("bytes=0-99");
	});

	it("resolves codec variants for MSE", async () => {
		headHeaders = { "Content-Length": "100", "Content-Type": "video/mp4" };
		StubMediaSource.isTypeSupported = (m) => m.includes("avc1.42E01E");
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});
		expect(StubMediaSource.instances).toHaveLength(1);
	});

	it("falls back to blob when appending fails", async () => {
		StubMediaSource.isTypeSupported = () => true;
		const { result } = renderHook(() => useMediaUrl("https://srv/v", "tok"));

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});

		const source = StubMediaSource.instances[0];
		StubMediaSource.failNextAppend = true;

		act(() => {
			source.emit("sourceopen");
		});

		// MSE failed: the hook retries as a plain blob download.
		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-1");
		});
	});

	it("revokes object URLs on unmount", async () => {
		const { result, unmount } = renderHook(() =>
			useMediaUrl("https://srv/v", "tok"),
		);

		await waitFor(() => {
			expect(result.current.mediaUrl).toBe("blob:mock-0");
		});

		unmount();

		expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
	});

	it("drops late responses after unmount", async () => {
		let resolveFetch!: (r: Response) => void;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((res) => {
						resolveFetch = res;
					}),
			),
		);

		const { result, unmount } = renderHook(() =>
			useMediaUrl("https://srv/v", "tok"),
		);
		unmount();
		act(() => {
			resolveFetch(new Response(null, { headers: headHeaders }));
		});

		await Promise.resolve();
		expect(result.current.mediaUrl).toBeNull();
	});
});
