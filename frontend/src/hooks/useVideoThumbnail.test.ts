import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoThumbnail } from "./useVideoThumbnail.ts";

interface FakeVideo {
	currentTime: number;
	videoWidth: number;
	videoHeight: number;
	listeners: Map<string, Array<() => void>>;
	loadCalls: number;
}

let video: FakeVideo;
let canvasCtx: { drawImage: ReturnType<typeof vi.fn> } | null;
let dataUrl: string;

function fire(type: string) {
	for (const cb of video.listeners.get(type) ?? []) cb();
}

beforeEach(() => {
	video = {
		currentTime: 0,
		videoWidth: 640,
		videoHeight: 480,
		listeners: new Map(),
		loadCalls: 0,
	};
	canvasCtx = { drawImage: vi.fn() };
	dataUrl = "data:image/jpeg;base64,x";

	const realCreateElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag !== "video" && tag !== "canvas") {
			return realCreateElement(tag);
		}
		if (tag === "canvas") {
			return {
				set width(_v: number) {},
				set height(_v: number) {},
				getContext: () => canvasCtx,
				toDataURL: () => dataUrl,
			};
		}
		return {
			set preload(_v: string) {},
			set muted(_v: boolean) {},
			set playsInline(_v: boolean) {},
			set src(_v: string) {},
			get videoWidth() {
				return video.videoWidth;
			},
			get videoHeight() {
				return video.videoHeight;
			},
			get duration() {
				return 10;
			},
			set currentTime(v: number) {
				video.currentTime = v;
			},
			addEventListener: (t: string, cb: () => void) => {
				const list = video.listeners.get(t) ?? [];
				list.push(cb);
				video.listeners.set(t, list);
			},
			removeEventListener: (t: string, cb: () => void) => {
				video.listeners.set(
					t,
					(video.listeners.get(t) ?? []).filter((f) => f !== cb),
				);
			},
			removeAttribute: vi.fn(),
			load: () => {
				video.loadCalls += 1;
			},
		};
	}) as unknown as typeof document.createElement);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useVideoThumbnail", () => {
	it("returns null without a URL", () => {
		const { result } = renderHook(() => useVideoThumbnail(undefined));

		expect(result.current).toBeNull();
	});

	it("captures a frame after seek", () => {
		const { result } = renderHook(() => useVideoThumbnail("blob:v"));

		act(() => {
			fire("loadedmetadata");
		});
		expect(video.currentTime).toBe(0.1);
		expect(result.current).toBeNull();

		act(() => {
			fire("seeked");
		});
		expect(canvasCtx?.drawImage).toHaveBeenCalledTimes(1);
		expect(result.current).toBe(dataUrl);
	});

	it("cleans up the element on unmount", () => {
		const { unmount } = renderHook(() => useVideoThumbnail("blob:v"));

		unmount();

		expect(video.loadCalls).toBe(1);
		expect(video.listeners.get("seeked")).toEqual([]);
	});

	it("falls back when the canvas is unavailable", () => {
		canvasCtx = null;
		const { result } = renderHook(() => useVideoThumbnail("blob:v"));

		act(() => {
			fire("seeked");
		});

		expect(result.current).toBeNull();
	});
});
