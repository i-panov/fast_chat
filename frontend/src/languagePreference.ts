// Shared by the i18n store and the "clear app data" flow: both must agree on
// the key, otherwise clearing data silently resets the chosen language.
export const LANGUAGE_PREFERENCE_KEY = "fastchat.language";
