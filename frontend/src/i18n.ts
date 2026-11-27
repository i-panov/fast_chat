import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { LANGUAGE_PREFERENCE_KEY } from "./languagePreference.ts";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

// Adding a language: import its JSON, add it to this map and provide the
// `lang.<code>` label in every locale. SUPPORTED_LANGS and the language
// selector derive from the map, so no other code changes are needed.
const RESOURCES = {
	en: { translation: en },
	ru: { translation: ru },
} as const;

export type Language = keyof typeof RESOURCES;
export type LanguagePreference = "system" | Language;

export const SUPPORTED_LANGS = Object.keys(RESOURCES) as Language[];

// The old detector cached the navigator language even when the user never
// picked one; it is migrated once and then removed.
const LEGACY_KEY = "i18nextLng";

function matchLang(raw: string | null | undefined): Language | null {
	if (raw === null || raw === undefined || raw === "") return null;
	const base = raw.split("-")[0]?.toLowerCase() ?? "";
	return (SUPPORTED_LANGS as string[]).includes(base)
		? (base as Language)
		: null;
}

export function pickLang(raw: string): Language {
	return matchLang(raw) ?? "en";
}

export function getCurrentLocale(): Language {
	return pickLang(i18n.language);
}

function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writePreference(preference: LanguagePreference): void {
	try {
		localStorage.setItem(LANGUAGE_PREFERENCE_KEY, preference);
	} catch {
		// Private mode: the choice only lives for this page load.
	}
}

export function systemLanguage(): Language {
	if (typeof navigator === "undefined") return "en";
	const tags =
		navigator.languages !== undefined && navigator.languages.length > 0
			? navigator.languages
			: [navigator.language];
	for (const tag of tags) {
		const match = matchLang(tag);
		if (match !== null) return match;
	}
	return "en";
}

export function getLanguagePreference(): LanguagePreference {
	const stored = readStorage(LANGUAGE_PREFERENCE_KEY);
	if (stored === "system") return "system";
	const explicit = matchLang(stored);
	if (explicit !== null) return explicit;

	// A legacy value that differs from the current system language is a real
	// choice; a matching one was only cached by the detector.
	const legacy = matchLang(readStorage(LEGACY_KEY));
	const preference: LanguagePreference =
		legacy !== null && legacy !== systemLanguage() ? legacy : "system";
	writePreference(preference);
	try {
		localStorage.removeItem(LEGACY_KEY);
	} catch {
		// Best effort.
	}
	return preference;
}

export function resolveLanguage(preference: LanguagePreference): Language {
	return preference === "system" ? systemLanguage() : preference;
}

export async function setLanguagePreference(
	preference: LanguagePreference,
): Promise<void> {
	writePreference(preference);
	await i18n.changeLanguage(resolveLanguage(preference));
}

const initialPreference = getLanguagePreference();

void i18n.use(initReactI18next).init({
	resources: RESOURCES,
	lng: resolveLanguage(initialPreference),
	fallbackLng: "en",
	interpolation: {
		escapeValue: false,
	},
});

if (typeof window !== "undefined") {
	// With "system" selected the interface follows the OS without a reload.
	window.addEventListener("languagechange", () => {
		if (getLanguagePreference() === "system") {
			void i18n.changeLanguage(systemLanguage());
		}
	});
}

export default i18n;
