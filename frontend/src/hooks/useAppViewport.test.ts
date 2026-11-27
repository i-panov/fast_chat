import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppViewport } from "./useAppViewport.ts";

const APP_HEIGHT_VAR = "--app-height";

function appHeight(): string {
	return document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR);
}

function mockViewport(height: number, scale = 1) {
	const target = new EventTarget() as EventTarget & {
		height: number;
		scale: number;
	};
	target.height = height;
	target.scale = scale;
	Object.defineProperty(window, "visualViewport", {
		value: target,
		configurable: true,
	});
	return target;
}

let frames: FrameRequestCallback[] = [];

function flushFrames(): void {
	const pending = frames;
	frames = [];
	for (const callback of pending) callback(0);
}

beforeEach(() => {
	frames = [];
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		frames[id - 1] = () => {};
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(window, "visualViewport");
	document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
});

describe("useAppViewport", () => {
	it("uses the visual viewport height", () => {
		mockViewport(612);
		renderHook(() => useAppViewport());
		expect(appHeight()).toBe("612px");
	});

	it("falls back to the window height without visualViewport", () => {
		Object.defineProperty(window, "innerHeight", {
			value: 700,
			configurable: true,
		});
		renderHook(() => useAppViewport());
		expect(appHeight()).toBe("700px");
	});

	it("follows viewport resizes", () => {
		const viewport = mockViewport(612);
		renderHook(() => useAppViewport());

		viewport.height = 480;
		viewport.dispatchEvent(new Event("resize"));
		flushFrames();

		expect(appHeight()).toBe("480px");

		viewport.height = 420;
		viewport.dispatchEvent(new Event("resize"));
		flushFrames();

		expect(appHeight()).toBe("420px");
	});

	it("ignores a zero height from a hidden viewport", () => {
		const viewport = mockViewport(612);
		renderHook(() => useAppViewport());
		expect(appHeight()).toBe("612px");

		viewport.height = 0;
		viewport.dispatchEvent(new Event("resize"));
		flushFrames();
		expect(appHeight()).toBe("612px");

		viewport.height = 500;
		viewport.dispatchEvent(new Event("resize"));
		flushFrames();
		expect(appHeight()).toBe("500px");
	});

	it("does not resize while the page is pinch-zoomed", () => {
		const viewport = mockViewport(612);
		renderHook(() => useAppViewport());

		viewport.height = 300;
		viewport.scale = 2;
		viewport.dispatchEvent(new Event("resize"));
		flushFrames();

		expect(appHeight()).toBe("612px");
	});

	it("removes the variable and listeners on unmount", () => {
		const viewport = mockViewport(612);
		const remove = vi.spyOn(viewport, "removeEventListener");
		const { unmount } = renderHook(() => useAppViewport());

		unmount();

		expect(appHeight()).toBe("");
		expect(remove).toHaveBeenCalled();
	});
});
