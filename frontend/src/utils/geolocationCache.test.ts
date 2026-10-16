import { afterEach, describe, expect, it } from "vitest";
import {
	getLastCachedLocation,
	requestGeolocation,
} from "./geolocationCache.ts";

function mockPositions(getCurrentPosition: Geolocation["getCurrentPosition"]) {
	Object.defineProperty(navigator, "geolocation", {
		value: { getCurrentPosition },
		configurable: true,
	});
}

function mockPosition(lat: number, lng: number) {
	mockPositions((ok) => {
		ok({
			coords: { latitude: lat, longitude: lng },
		} as GeolocationPosition);
	});
}

afterEach(() => {
	localStorage.clear();
	Reflect.deleteProperty(navigator, "geolocation");
});

describe("geolocationCache", () => {
	it("returns null when nothing is cached", () => {
		expect(getLastCachedLocation()).toBeNull();
	});

	it("caches the resolved position and returns it", async () => {
		mockPosition(10, 20);

		await expect(requestGeolocation()).resolves.toEqual({ lat: 10, lng: 20 });
		expect(getLastCachedLocation()).toEqual({ lat: 10, lng: 20 });
	});

	it("returns null for invalid stored JSON", () => {
		localStorage.setItem("lastGeolocation", "not-json{");

		expect(getLastCachedLocation()).toBeNull();
	});

	it("returns null for non-numeric coordinates", () => {
		localStorage.setItem(
			"lastGeolocation",
			JSON.stringify({ lat: "10", lng: 20 }),
		);

		expect(getLastCachedLocation()).toBeNull();

		localStorage.setItem(
			"lastGeolocation",
			JSON.stringify({ lat: Number.NaN, lng: 20 }),
		);

		expect(getLastCachedLocation()).toBeNull();
	});

	it("rejects when geolocation is unavailable", async () => {
		await expect(requestGeolocation()).rejects.toThrow();
		expect(getLastCachedLocation()).toBeNull();
	});

	it("rejects with the platform error", async () => {
		const failure = new Error("denied");
		mockPositions((_ok, err) => {
			(err as unknown as (e: Error) => void)?.(failure);
		});

		await expect(requestGeolocation()).rejects.toBe(failure);
	});

	it("wraps non-Error failures", async () => {
		mockPositions((_ok, err) => {
			err?.({ message: "denied" } as GeolocationPositionError);
		});

		await expect(requestGeolocation()).rejects.toThrow("denied");
	});
});
