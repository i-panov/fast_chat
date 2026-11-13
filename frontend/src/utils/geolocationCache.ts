import type { Location } from "../types/api.ts";

// Kept in memory only: coordinates are sensitive and must not survive the
// session or be readable by another script on the origin.
let cachedLocation: Location | null = null;

export function getLastCachedLocation(): Location | null {
	return cachedLocation;
}

export function clearLastCachedLocation(): void {
	cachedLocation = null;
}

function saveLastCachedLocation(loc: Location): void {
	cachedLocation = { lat: loc.lat, lng: loc.lng };
}

export function requestGeolocation(
	options?: PositionOptions,
): Promise<Location> {
	return new Promise((resolve, reject) => {
		if (
			typeof navigator === "undefined" ||
			navigator.geolocation === undefined
		) {
			reject(new Error("Geolocation not available"));
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				const loc: Location = {
					lat: pos.coords.latitude,
					lng: pos.coords.longitude,
				};
				saveLastCachedLocation(loc);
				resolve(loc);
			},
			(err) => {
				reject(err instanceof Error ? err : new Error(err.message));
			},
			options ?? { enableHighAccuracy: true, timeout: 10_000 },
		);
	});
}
