import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { beforeEach } from "vitest";

import { resetAllDBs, setActiveAccountKey } from "./src/db/init.ts";

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
