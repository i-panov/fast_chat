import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLocationPicker } from "./useLocationPicker.ts";

describe("useLocationPicker", () => {
	it("opens, confirms and clears the location", () => {
		const { result } = renderHook(() => useLocationPicker());

		expect(result.current.pendingLocation).toBeNull();
		expect(result.current.locationPickerOpen).toBe(false);

		act(() => {
			result.current.openLocationPicker();
		});
		expect(result.current.locationPickerOpen).toBe(true);

		act(() => {
			result.current.handleLocationConfirm({ lat: 1, lng: 2 });
		});
		expect(result.current.pendingLocation).toEqual({ lat: 1, lng: 2 });
		expect(result.current.locationPickerOpen).toBe(false);

		act(() => {
			result.current.clearPendingLocation();
		});
		expect(result.current.pendingLocation).toBeNull();
	});

	it("replaces the pending location on a later confirmation", () => {
		const { result } = renderHook(() => useLocationPicker());

		act(() => {
			result.current.handleLocationConfirm({ lat: 1, lng: 2 });
		});
		act(() => {
			result.current.handleLocationConfirm({ lat: 3, lng: 4 });
		});

		expect(result.current.pendingLocation).toEqual({ lat: 3, lng: 4 });
	});

	it("keeps the pending location when the picker is reopened", () => {
		const { result } = renderHook(() => useLocationPicker());

		act(() => {
			result.current.handleLocationConfirm({ lat: 1, lng: 2 });
		});
		act(() => {
			result.current.openLocationPicker();
		});

		expect(result.current.locationPickerOpen).toBe(true);
		expect(result.current.pendingLocation).toEqual({ lat: 1, lng: 2 });
	});
});
