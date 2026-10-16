import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllData } from "./clearAllData.ts";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe("clearAllData", () => {
	it("clears storages but preserves the language", async () => {
		localStorage.setItem("i18nextLng", "ru");
		localStorage.setItem("other", "x");
		sessionStorage.setItem("s", "y");

		await clearAllData();

		expect(localStorage.getItem("i18nextLng")).toBe("ru");
		expect(localStorage.getItem("other")).toBeNull();
		expect(sessionStorage.getItem("s")).toBeNull();
	});

	it("resolves without a stored language", async () => {
		localStorage.setItem("other", "x");

		await clearAllData();

		expect(localStorage.length).toBe(0);
	});

	it("unsubscribes push, clears caches and unregisters the worker", async () => {
		const unsubscribe = vi.fn(() => Promise.resolve(true));
		const unregister = vi.fn(() => Promise.resolve(true));
		const cacheDelete = vi.fn((_name: string) => Promise.resolve(true));
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: () => Promise.resolve({ unsubscribe }),
					},
				}),
				getRegistration: () => Promise.resolve({ unregister }),
			},
			configurable: true,
		});
		vi.stubGlobal("caches", {
			keys: () => Promise.resolve(["v1", "v2"]),
			delete: cacheDelete,
		});

		await clearAllData();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(cacheDelete).toHaveBeenCalledWith("v1");
		expect(cacheDelete).toHaveBeenCalledWith("v2");
		expect(unregister).toHaveBeenCalledTimes(1);

		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("skips push when there is no subscription", async () => {
		const getSubscription = vi.fn(() => Promise.resolve(null));
		Object.defineProperty(navigator, "serviceWorker", {
			value: {
				ready: Promise.resolve({ pushManager: { getSubscription } }),
				getRegistration: () => Promise.resolve(null),
			},
			configurable: true,
		});

		await clearAllData();

		expect(getSubscription).toHaveBeenCalledTimes(1);

		Reflect.deleteProperty(navigator, "serviceWorker");
	});
});
