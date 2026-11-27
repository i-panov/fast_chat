import { getActiveAccountKey } from "../db/init.ts";
import type { Location } from "../types/api.ts";

// Kept in memory only: coordinates are sensitive and must not survive the
// session or be readable by another script on the origin. The entry is bound
// to the account that produced it: after an account switch the next user must
// not see (or accidentally send) the previous user's position.
interface CachedLocation {
	accountKey: string | null;
	location: Location;
}

let cachedLocation: CachedLocation | null = null;

export function getLastCachedLocation(): Location | null {
	if (
		cachedLocation === null ||
		cachedLocation.accountKey !== getActiveAccountKey()
	) {
		return null;
	}

	return cachedLocation.location;
}

export function clearLastCachedLocation(): void {
	cachedLocation = null;
}

function saveLastCachedLocation(
	loc: Location,
	accountKey: string | null,
): void {
	cachedLocation = {
		accountKey,
		location: { lat: loc.lat, lng: loc.lng },
	};
}

export function requestGeolocation(
	options?: PositionOptions,
): Promise<Location> {
	const accountKey = getActiveAccountKey();

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
				// Bind to the account that asked, even if the active account
				// changes while the request is in flight.
				saveLastCachedLocation(loc, accountKey);
				resolve(loc);
			},
			(err) => {
				if (err instanceof Error) {
					reject(err);
					return;
				}
				// GeolocationPositionError is not an Error: keep its `code` so
				// the picker can tell a timeout from a refusal.
				const wrapped = new Error(err.message) as Error & { code?: number };
				wrapped.code = err.code;
				reject(wrapped);
			},
			options ?? { enableHighAccuracy: true, timeout: 10_000 },
		);
	});
}
