import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, {
	getLanguagePreference,
	pickLang,
	resolveLanguage,
	setLanguagePreference,
	systemLanguage,
} from "./i18n.ts";
import { LANGUAGE_PREFERENCE_KEY } from "./languagePreference.ts";

function setNavigatorLanguages(languages: string[]): void {
	Object.defineProperty(window.navigator, "languages", {
		value: languages,
		configurable: true,
	});
	Object.defineProperty(window.navigator, "language", {
		value: languages[0] ?? "en",
		configurable: true,
	});
}

beforeEach(() => {
	localStorage.clear();
	setNavigatorLanguages(["ru-RU"]);
});

afterEach(() => {
	localStorage.clear();
});

describe("language preference", () => {
	it("defaults to the system language", () => {
		expect(getLanguagePreference()).toBe("system");
		expect(resolveLanguage("system")).toBe("ru");
	});

	it("keeps an explicit choice", () => {
		localStorage.setItem(LANGUAGE_PREFERENCE_KEY, "en");
		expect(getLanguagePreference()).toBe("en");
		expect(resolveLanguage("en")).toBe("en");
	});

	it("treats a legacy value matching the system as system", () => {
		localStorage.setItem("i18nextLng", "ru");
		expect(getLanguagePreference()).toBe("system");
		expect(localStorage.getItem(LANGUAGE_PREFERENCE_KEY)).toBe("system");
		expect(localStorage.getItem("i18nextLng")).toBeNull();
	});

	it("treats a legacy value differing from the system as explicit", () => {
		localStorage.setItem("i18nextLng", "en");
		expect(getLanguagePreference()).toBe("en");
		expect(localStorage.getItem(LANGUAGE_PREFERENCE_KEY)).toBe("en");
	});

	it("falls back to English for unsupported system languages", () => {
		setNavigatorLanguages(["de-DE", "fr-FR"]);
		expect(systemLanguage()).toBe("en");
		expect(resolveLanguage("system")).toBe("en");
	});

	it("uses the first supported language from the list", () => {
		setNavigatorLanguages(["de-DE", "ru-RU"]);
		expect(systemLanguage()).toBe("ru");
	});

	it("changes the i18next language when the preference is saved", async () => {
		await setLanguagePreference("en");
		expect(i18n.language).toBe("en");
		expect(localStorage.getItem(LANGUAGE_PREFERENCE_KEY)).toBe("en");

		await setLanguagePreference("system");
		expect(i18n.language).toBe("ru");
		expect(localStorage.getItem(LANGUAGE_PREFERENCE_KEY)).toBe("system");
	});

	it("picks the base language from a regional tag", () => {
		expect(pickLang("ru-RU")).toBe("ru");
		expect(pickLang("en-US")).toBe("en");
		expect(pickLang("de-DE")).toBe("en");
	});

	it("follows the system language when the preference is system", async () => {
		await setLanguagePreference("system");
		expect(i18n.language).toBe("ru");

		setNavigatorLanguages(["en-US"]);
		window.dispatchEvent(new Event("languagechange"));

		await vi.waitFor(() => expect(i18n.language).toBe("en"));
	});

	it("keeps an explicit choice when the system language changes", async () => {
		await setLanguagePreference("ru");

		setNavigatorLanguages(["en-US"]);
		window.dispatchEvent(new Event("languagechange"));
		await Promise.resolve();

		expect(i18n.language).toBe("ru");
	});
});
