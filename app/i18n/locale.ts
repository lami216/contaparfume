export const LOCALE_COOKIE = "alkarna_locale";
export const supportedLocales = ["ar", "fr"] as const;
export type Locale = typeof supportedLocales[number];
export const DEFAULT_LOCALE: Locale = "ar";

export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "fr";
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function direction(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function localeTag(locale: Locale) {
  return locale === "ar" ? "ar-MR-u-nu-latn" : "fr-MR-u-nu-latn";
}
