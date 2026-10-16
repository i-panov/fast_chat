import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Location } from "../../types/api.ts";
import { LocationPickerModal } from "./LocationPickerModal.tsx";

type MapClickEvent = { latlng: { lat: number; lng: number } };
type MapHandler = (e: MapClickEvent) => void;

const clickHandlers: MapHandler[] = [];
const setView = vi.fn();

vi.mock("react-leaflet", () => ({
	MapContainer: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="map">{children}</div>
	),
	Marker: () => null,
	TileLayer: () => null,
	useMap: () => ({ setView, getZoom: () => 13, invalidateSize: () => {} }),
	useMapEvents: (events: { click: (e: MapClickEvent) => void }) => {
		clickHandlers.push((e) => events.click(e));
	},
}));

const SEND_BUTTON = /Send location|input\.locationSend/;
const CANCEL_BUTTON = /^(Cancel|input\.locationCancel)$/;
const LOCATE_BUTTON = /Use my location|input\.locationGetCurrent/;

function mockGeolocation(
	getCurrentPosition: Geolocation["getCurrentPosition"],
) {
	Object.defineProperty(navigator, "geolocation", {
		value: { getCurrentPosition },
		configurable: true,
	});
}

function rejectGeolocation() {
	mockGeolocation((_ok, err) => {
		err?.({ message: "denied" } as GeolocationPositionError);
	});
}

function acceptGeolocation(lat: number, lng: number) {
	mockGeolocation((ok) => {
		ok({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition);
	});
}

function renderModal(props: {
	initial?: Location | null;
	onConfirm?: (loc: Location) => void;
	onClose?: () => void;
}) {
	return render(
		<MantineProvider>
			<LocationPickerModal
				open={true}
				initial={props.initial ?? null}
				onClose={props.onClose ?? (() => {})}
				onConfirm={props.onConfirm ?? (() => {})}
			/>
		</MantineProvider>,
	);
}

function coordInputs(): HTMLInputElement[] {
	const inputs = [...document.querySelectorAll("input")].filter(
		(el): el is HTMLInputElement => el instanceof HTMLInputElement,
	);
	if (inputs.length < 2) throw new Error("coord inputs not rendered");

	return inputs;
}

function clickSend() {
	fireEvent.click(screen.getByText(SEND_BUTTON));
}

beforeEach(() => {
	clickHandlers.length = 0;
	setView.mockClear();
	localStorage.clear();
	rejectGeolocation();
});

describe("location picker modal", () => {
	it("confirms the default center", () => {
		const onConfirm = vi.fn();
		renderModal({ onConfirm });

		clickSend();

		expect(onConfirm).toHaveBeenCalledWith({ lat: 55.7558, lng: 37.6173 });
	});

	it("starts from the initial location", () => {
		const onConfirm = vi.fn();
		renderModal({ initial: { lat: 10, lng: 20 }, onConfirm });

		clickSend();

		expect(onConfirm).toHaveBeenCalledWith({ lat: 10, lng: 20 });
	});

	it("applies the cached location", async () => {
		localStorage.setItem("lastGeolocation", JSON.stringify({ lat: 1, lng: 2 }));
		const onConfirm = vi.fn();
		renderModal({ onConfirm });

		await waitFor(() => {
			expect(onConfirm).not.toHaveBeenCalled();
		});
		clickSend();

		// The rejected live lookup leaves the cached position in place.
		expect(onConfirm).toHaveBeenCalledWith({ lat: 1, lng: 2 });
	});

	it("moves the pin on map click", () => {
		const onConfirm = vi.fn();
		renderModal({ onConfirm });

		act(() => {
			// Snapshot: each render registers another handler.
			for (const cb of [...clickHandlers]) cb({ latlng: { lat: 48, lng: 2 } });
		});
		clickSend();

		expect(onConfirm).toHaveBeenCalledWith({ lat: 48, lng: 2 });
	});

	it("edits coordinates by hand and validates them", () => {
		const onConfirm = vi.fn();
		renderModal({ onConfirm });
		const [lat, lng] = coordInputs();

		fireEvent.change(lat, { target: { value: "91" } });
		fireEvent.change(lng, { target: { value: "0" } });
		clickSend();

		expect(onConfirm).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toBeTruthy();
	});

	it("locates the device on demand", async () => {
		acceptGeolocation(5, 6);
		const onConfirm = vi.fn();
		renderModal({ onConfirm });

		fireEvent.click(screen.getByText(LOCATE_BUTTON));

		await waitFor(() => {
			clickSend();
			expect(onConfirm).toHaveBeenCalledWith({ lat: 5, lng: 6 });
		});
	});

	it("shows an error when locating fails", async () => {
		const onConfirm = vi.fn();
		renderModal({ onConfirm });

		fireEvent.click(screen.getByText(LOCATE_BUTTON));

		await screen.findByRole("alert");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("closes without confirming", () => {
		const onClose = vi.fn();
		renderModal({ onClose });

		fireEvent.click(screen.getByText(CANCEL_BUTTON));

		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
