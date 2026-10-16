import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapAutoSize, MapClickHandler } from "./MapHelpers.tsx";

type ClickListener = (e: { latlng: { lat: number; lng: number } }) => void;

const handlers: Record<string, ClickListener[]> = {};
const invalidateSize = vi.fn();

vi.mock("react-leaflet", () => ({
	useMap: () => ({ invalidateSize }),
	useMapEvents: (events: Record<string, ClickListener>) => {
		for (const [type, cb] of Object.entries(events)) {
			const list = handlers[type] ?? [];
			list.push(cb);
			handlers[type] = list;
		}
	},
}));

beforeEach(() => {
	for (const key of Object.keys(handlers)) delete handlers[key];
	invalidateSize.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("MapHelpers", () => {
	it("invalidates the size when opened", () => {
		render(<MapAutoSize open={true} />);

		act(() => {
			vi.advanceTimersByTime(200);
		});

		expect(invalidateSize).toHaveBeenCalledTimes(1);
	});

	it("does nothing when closed", () => {
		render(<MapAutoSize open={false} />);

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(invalidateSize).not.toHaveBeenCalled();
	});

	it("forwards map clicks as locations", () => {
		const onClick = vi.fn();
		render(<MapClickHandler onClick={onClick} />);

		for (const cb of handlers.click ?? []) {
			cb({ latlng: { lat: 10, lng: 20 } });
		}

		expect(onClick).toHaveBeenCalledWith({ lat: 10, lng: 20 });
	});
});
