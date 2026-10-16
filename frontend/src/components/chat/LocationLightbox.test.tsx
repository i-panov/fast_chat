import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Location } from "../../types/api.ts";
import { LocationLightbox } from "./LocationLightbox.tsx";

const clickHandlers: Array<
	(e: { latlng: { lat: number; lng: number } }) => void
> = [];

vi.mock("react-leaflet", () => ({
	MapContainer: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="map">{children}</div>
	),
	Marker: () => null,
	TileLayer: () => null,
	useMap: () => ({ setView: () => {}, getZoom: () => 15 }),
	useMapEvents: (events: {
		click: (e: { latlng: { lat: number; lng: number } }) => void;
	}) => {
		clickHandlers.push((e) => events.click(e));
	},
}));

const SAVE_BUTTON = /Save|input\.save/;
const CLEAR_BUTTON = /Remove location|input\.locationClear/;

function renderLightbox(props: {
	location?: Location;
	editable?: boolean;
	onChange?: (loc: Location) => void;
	onRemove?: () => void;
}) {
	return render(
		<MantineProvider>
			<LocationLightbox
				open={true}
				location={props.location ?? { lat: 10, lng: 20 }}
				editable={props.editable ?? false}
				onClose={() => {}}
				onChange={props.onChange}
				onRemove={props.onRemove}
			/>
		</MantineProvider>,
	);
}

beforeEach(() => {
	clickHandlers.length = 0;
});

describe("location lightbox", () => {
	it("shows the coordinates and map link", () => {
		renderLightbox({});

		expect(screen.getByText("10.000000, 20.000000")).toBeTruthy();
		const link = [...document.querySelectorAll("a")].find((a) =>
			a.href.includes("openstreetmap"),
		);
		expect(link?.href).toContain("mlat=10");
	});

	it("moves the pin on map click when editable", () => {
		const onChange = vi.fn();
		renderLightbox({ editable: true, onChange });

		// Snapshot: each render registers another handler, so iterating
		// the live array would never terminate once act() flushes sync.
		for (const cb of [...clickHandlers]) {
			act(() => {
				cb({ latlng: { lat: 48, lng: 2 } });
			});
		}
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		expect(onChange).toHaveBeenCalledWith({ lat: 48, lng: 2 });
	});

	it("removes the location", () => {
		const onRemove = vi.fn();
		renderLightbox({ editable: true, onRemove });

		fireEvent.click(screen.getByText(CLEAR_BUTTON));

		expect(onRemove).toHaveBeenCalledTimes(1);
	});

	it("hides edit controls when readonly", () => {
		renderLightbox({});

		expect(screen.queryByText(SAVE_BUTTON)).toBeNull();
		expect(screen.queryByText(CLEAR_BUTTON)).toBeNull();
	});
});
