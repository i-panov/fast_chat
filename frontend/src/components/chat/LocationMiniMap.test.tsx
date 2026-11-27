import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocationMiniMap } from "./LocationMiniMap.tsx";

vi.mock("react-leaflet", () => ({
	MapContainer: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="mini-map">{children}</div>
	),
	Marker: () => null,
	TileLayer: () => null,
	useMap: () => ({ invalidateSize: () => {} }),
}));

vi.mock("../../utils/leafletIconFix.ts", () => ({}));

describe("LocationMiniMap", () => {
	it("does not request map tiles before the user asks", () => {
		render(
			<MantineProvider>
				<LocationMiniMap location={{ lat: 10, lng: 20 }} />
			</MantineProvider>,
		);

		// The coordinates of an E2EE location must not reach the tile server
		// just because the message was rendered.
		expect(screen.queryByTestId("mini-map")).toBeNull();
		expect(screen.getByRole("button")).toBeTruthy();
	});

	it("loads the map on click", async () => {
		render(
			<MantineProvider>
				<LocationMiniMap location={{ lat: 10, lng: 20 }} />
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button"));

		expect(await screen.findByTestId("mini-map")).toBeTruthy();
	});
});
