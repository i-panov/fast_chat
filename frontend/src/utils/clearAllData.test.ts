import { beforeEach, describe, expect, it } from "vitest";
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
});
