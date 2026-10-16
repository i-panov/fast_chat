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

	it("toggles the picker directly", () => {
		const { result } = renderHook(() => useLocationPicker());

		act(() => {
			result.current.setLocationPickerOpen(true);
		});
		expect(result.current.locationPickerOpen).toBe(true);
	});
});
