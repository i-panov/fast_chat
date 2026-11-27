import { metaRepo } from "../db/metaRepo.ts";

export interface LocalLockSettings {
	inactivityMs: number | null;
	backgroundMs: number | null;
	lockOnFreeze: boolean;
	lockAfterSleep: boolean;
}

const SETTINGS_META = "e2ee.lockSettings";
export const LOCAL_LOCK_SETTINGS_EVENT = "fastchat-local-lock-settings";
const SETTINGS_CHANNEL = "fastchat-lock-settings";

export const DEFAULT_LOCK_SETTINGS: LocalLockSettings = {
	inactivityMs: 15 * 60 * 1000,
	backgroundMs: 5 * 60 * 1000,
	lockOnFreeze: true,
	lockAfterSleep: true,
};

export async function getLocalLockSettings(): Promise<LocalLockSettings> {
	const value = await metaRepo.get(SETTINGS_META);
	if (value === null || typeof value !== "object") {
		return DEFAULT_LOCK_SETTINGS;
	}
	const raw = value as Partial<LocalLockSettings>;
	const ms = (
		candidate: unknown,
		fallback: number | null,
		allowZero = false,
	) =>
		candidate === null
			? null
			: typeof candidate === "number" &&
					Number.isFinite(candidate) &&
					(candidate > 0 || (allowZero && candidate === 0))
				? candidate
				: fallback;
	return {
		inactivityMs: ms(raw.inactivityMs, DEFAULT_LOCK_SETTINGS.inactivityMs),
		backgroundMs: ms(
			raw.backgroundMs,
			DEFAULT_LOCK_SETTINGS.backgroundMs,
			true,
		),
		lockOnFreeze:
			typeof raw.lockOnFreeze === "boolean"
				? raw.lockOnFreeze
				: DEFAULT_LOCK_SETTINGS.lockOnFreeze,
		lockAfterSleep:
			typeof raw.lockAfterSleep === "boolean"
				? raw.lockAfterSleep
				: DEFAULT_LOCK_SETTINGS.lockAfterSleep,
	};
}

export async function setLocalLockSettings(
	settings: LocalLockSettings,
): Promise<void> {
	await metaRepo.setNoNotify(SETTINGS_META, settings);
	window.dispatchEvent(new Event(LOCAL_LOCK_SETTINGS_EVENT));
	try {
		if (typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(SETTINGS_CHANNEL);
			channel.postMessage({ changed: true });
			channel.close();
		}
	} catch {
		// Best effort.
	}
}

export function onLocalLockSettingsChanged(listener: () => void): () => void {
	window.addEventListener(LOCAL_LOCK_SETTINGS_EVENT, listener);
	let channel: BroadcastChannel | null = null;
	if (typeof BroadcastChannel !== "undefined") {
		channel = new BroadcastChannel(SETTINGS_CHANNEL);
		channel.onmessage = () => listener();
	}
	return () => {
		window.removeEventListener(LOCAL_LOCK_SETTINGS_EVENT, listener);
		channel?.close();
	};
}
