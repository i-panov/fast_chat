import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import {
	clearLastCachedLocation,
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

beforeEach(() => {
	setActiveAccountKey("alice:test");
	clearLastCachedLocation();
});

afterEach(() => {
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

	it("ignores legacy localStorage entries", () => {
		localStorage.setItem("lastGeolocation", JSON.stringify({ lat: 1, lng: 2 }));

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

	it("keeps the geolocation error code", async () => {
		mockPositions((_ok, err) => {
			err?.({ message: "timeout", code: 3 } as GeolocationPositionError);
		});

		await expect(requestGeolocation()).rejects.toMatchObject({ code: 3 });
	});

	it("does not leak a position across accounts", async () => {
		mockPosition(10, 20);
		await requestGeolocation();
		expect(getLastCachedLocation()).toEqual({ lat: 10, lng: 20 });

		setActiveAccountKey("bob:test");

		expect(getLastCachedLocation()).toBeNull();
	});
});
