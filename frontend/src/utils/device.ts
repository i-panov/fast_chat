import type { DeviceInfo } from "../types/api.ts";

const DEVICE_ID_KEY = "fastchat.deviceId";
const EDGE_RE = /Edg\//;
const FIREFOX_RE = /Firefox\//;
const CHROME_RE = /Chrome\//;
const SAFARI_RE = /Safari\//;
const ANDROID_RE = /Android/;
const IOS_RE = /iPhone|iPad|iPod/;
const WINDOWS_RE = /Windows/;
const MAC_RE = /Mac OS X/;
const LINUX_RE = /Linux/;

// getDeviceId returns a stable per-browser-profile identifier. It is not a
// secret and never authenticates anything by itself; the server binds the
// session to it so a re-login on the same device replaces that session
// instead of creating another one.
export function getDeviceId(): string {
	try {
		const stored = localStorage.getItem(DEVICE_ID_KEY);
		if (stored !== null && stored.length > 0 && stored.length <= 128) {
			return stored;
		}
	} catch {
		// localStorage may be blocked; fall through to an in-memory id.
	}

	const id =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;

	try {
		localStorage.setItem(DEVICE_ID_KEY, id);
	} catch {
		// Private mode: the id only lives for this page load.
	}

	return id;
}

// getDeviceName builds a short human-readable name for the devices list.
export function getDeviceName(): string {
	if (typeof navigator === "undefined") return "Unknown device";

	const ua = navigator.userAgent;
	const browser = EDGE_RE.test(ua)
		? "Edge"
		: FIREFOX_RE.test(ua)
			? "Firefox"
			: CHROME_RE.test(ua)
				? "Chrome"
				: SAFARI_RE.test(ua)
					? "Safari"
					: "Browser";
	const os = ANDROID_RE.test(ua)
		? "Android"
		: IOS_RE.test(ua)
			? "iOS"
			: WINDOWS_RE.test(ua)
				? "Windows"
				: MAC_RE.test(ua)
					? "macOS"
					: LINUX_RE.test(ua)
						? "Linux"
						: "Unknown OS";

	return `${browser} on ${os}`;
}

export function getDeviceInfo(): DeviceInfo {
	return { deviceId: getDeviceId(), deviceName: getDeviceName() };
}
