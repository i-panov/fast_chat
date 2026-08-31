import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

const SUPPORTED_LANGS = ["en", "ru"];

function pickLang(raw: string): string {
	const base = raw.split("-")[0]?.toLowerCase() ?? "";
	return SUPPORTED_LANGS.includes(base) ? base : "en";
}

export function getCurrentLocale(): string {
	return pickLang(i18n.language);
}

void i18n
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		resources: {
			en: { translation: en },
			ru: { translation: ru },
		},
		fallbackLng: "en",
		detection: {
			order: ["localStorage", "navigator"],
			caches: ["localStorage"],
		},
		interpolation: {
			escapeValue: false,
		},
	});

export default i18n;
export { SUPPORTED_LANGS, pickLang };
