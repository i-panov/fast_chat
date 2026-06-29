import type { Location } from "../api.ts";

const CACHED_LOCATION_KEY = "lastGeolocation";

export function getLastCachedLocation(): Location | null {
	try {
		const raw = localStorage.getItem(CACHED_LOCATION_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw);
		if (
			typeof parsed.lat === "number" &&
			typeof parsed.lng === "number" &&
			!Number.isNaN(parsed.lat) &&
			!Number.isNaN(parsed.lng)
		) {
			return { lat: parsed.lat, lng: parsed.lng };
		}
		return null;
	} catch {
		return null;
	}
}

function saveLastCachedLocation(loc: Location): void {
	try {
		localStorage.setItem(CACHED_LOCATION_KEY, JSON.stringify(loc));
	} catch {
		// localStorage may be full or blocked
	}
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
				reject(err);
			},
			options ?? { enableHighAccuracy: true, timeout: 10_000 },
		);
	});
}
