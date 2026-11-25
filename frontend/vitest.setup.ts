import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { afterAll, beforeEach } from "vitest";

// Captured before any test can replace it: the per-file flush below must not
// wait on a fake timer another test left enabled.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

import { resetAllDBs, setActiveAccountKey } from "./src/db/init.ts";

// jsdom's/node:util's TextEncoder produce Uint8Arrays from a different
// realm, breaking `instanceof Uint8Array` checks inside
// libsodium-wrappers. Shims allocate in the test realm instead.
class TestTextEncoder implements TextEncoder {
	readonly encoding = "utf-8";

	encode(input: string = ""): Uint8Array<ArrayBuffer> {
		return Uint8Array.from(
			Buffer.from(input, "utf8"),
		);
	}

	encodeInto(
		source: string,
		dest: Uint8Array,
	): { read: number; written: number } {
		const buf = Buffer.from(source, "utf8");
		const written = Math.min(buf.length, dest.length);
		dest.set(buf.subarray(0, written));
		return { read: source.length, written };
	}
}

class TestTextDecoder implements TextDecoder {
	readonly encoding = "utf-8";
	readonly fatal = false;
	readonly ignoreBOM = false;

	decode(input?: AllowSharedBufferSource): string {
		if (input === undefined) return "";
		const bytes =
			input instanceof Uint8Array
				? input
				: new Uint8Array(input as ArrayBuffer);
		return Buffer.from(bytes).toString("utf8");
	}
}

globalThis.TextEncoder = TestTextEncoder;
globalThis.TextDecoder = TestTextDecoder;

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = ResizeObserverMock;
}

if (typeof window.matchMedia !== "function") {
	window.matchMedia = ((query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}));
}

if (typeof window.scrollTo !== "function") {
	window.scrollTo = () => {};
}

// Each test starts from a clean IndexedDB state.
beforeEach(async () => {
	setActiveAccountKey(null);
	await resetAllDBs();
});

// Mantine's Transition schedules a state update on a timer (dialog enter and
// exit). When the last test of a file ends while a transition is still
// running, that timer fires after the environment is torn down and React
// crashes on the missing `window`. One short flush per file lets those timers
// run while jsdom is still alive.
afterAll(async () => {
	await new Promise((resolve) => nativeSetTimeout(resolve, 400));
});
