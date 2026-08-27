import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { beforeEach } from "vitest";

import { resetAllDBs, setActiveAccountKey } from "./src/db/init.ts";

// jsdom's/node:util's TextEncoder produce Uint8Arrays from a different
// realm, breaking `instanceof Uint8Array` checks inside
// libsodium-wrappers. Shims allocate in the test realm instead.
class TestTextEncoder implements TextEncoder {
	readonly encoding = "utf-8";

	encode(input: string = ""): Uint8Array<ArrayBuffer> {
		return Uint8Array.from(
			Buffer.from(input, "utf8"),
		) as unknown as Uint8Array<ArrayBuffer>;
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

globalThis.TextEncoder = TestTextEncoder as unknown as typeof TextEncoder;
globalThis.TextDecoder = TestTextDecoder as unknown as typeof TextDecoder;

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
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
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
}

if (typeof window.scrollTo !== "function") {
	window.scrollTo = () => {};
}

// Each test starts from a clean IndexedDB state.
beforeEach(async () => {
	setActiveAccountKey(null);
	await resetAllDBs();
});
