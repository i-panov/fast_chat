import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	useNetworkStatus,
	useOnlineNotifications,
} from "./useNetworkStatus.ts";

function setOnLine(value: boolean) {
	Object.defineProperty(window.navigator, "onLine", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	setOnLine(true);
	vi.restoreAllMocks();
});

describe("useNetworkStatus", () => {
	it("reflects the current online state", () => {
		const { result } = renderHook(() => useNetworkStatus());

		expect(result.current).toBe(true);
	});

	it("updates on offline and online events", () => {
		const { result } = renderHook(() => useNetworkStatus());

		act(() => {
			setOnLine(false);
			window.dispatchEvent(new Event("offline"));
		});
		expect(result.current).toBe(false);

		act(() => {
			setOnLine(true);
			window.dispatchEvent(new Event("online"));
		});
		expect(result.current).toBe(true);
	});
});

describe("useOnlineNotifications", () => {
	it("calls back when coming back online", () => {
		const onBackOnline = vi.fn();
		renderHook(() => useOnlineNotifications(onBackOnline));

		act(() => {
			setOnLine(false);
			window.dispatchEvent(new Event("online"));
		});
		expect(onBackOnline).not.toHaveBeenCalled();

		act(() => {
			setOnLine(true);
			window.dispatchEvent(new Event("online"));
		});
		expect(onBackOnline).toHaveBeenCalledTimes(1);
	});
});
