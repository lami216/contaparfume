export const DEFAULT_CURRENCY_CODE = "MRU";
export const MAX_CURRENCY_CODES = 30;

export type CurrencySettings = {
  code: string;
  availableCodes: string[];
};

export function normalizeCurrencyCode(value: unknown) {
  if (typeof value !== "string") return null;
  const code=value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function defaultCurrencySettings(): CurrencySettings {
  return { code: DEFAULT_CURRENCY_CODE, availableCodes: [DEFAULT_CURRENCY_CODE] };
}

export function normalizeCurrencySettings(value: unknown): CurrencySettings {
  const body=value&&typeof value==="object"?value as Record<string,unknown>:{};
  const code=normalizeCurrencyCode(body.code)??DEFAULT_CURRENCY_CODE;
  const input=Array.isArray(body.availableCodes)?body.availableCodes:[];
  const availableCodes=[...new Set([DEFAULT_CURRENCY_CODE,...input.map(normalizeCurrencyCode).filter((item):item is string=>Boolean(item)),code])];
  return { code, availableCodes };
}

let displayCurrencyCode=DEFAULT_CURRENCY_CODE;

export function setDisplayCurrencyCode(value: unknown) {
  displayCurrencyCode=normalizeCurrencyCode(value)??DEFAULT_CURRENCY_CODE;
  return displayCurrencyCode;
}

export function getDisplayCurrencyCode() {
  return displayCurrencyCode;
}
