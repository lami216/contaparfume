import { getDisplayCurrencyCode } from "../../lib/currency-core";
import { formatAccountingDecimal, formatAccountingPercentage, type AccountingFormatOptions } from "../../lib/accounting-format";
import { localeTag, type Locale } from "./locale";

export const western = (value: string) => value
  .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
  .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));

export function formatNumber(locale: Locale, value: number, options: Intl.NumberFormatOptions = {}) {
  return western(new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 0, numberingSystem: "latn", ...options }).format(value));
}
export const formatQuantity = (locale: Locale, value: number) => formatNumber(locale, value);
export const formatMoney = (locale: Locale, value: number) => `${formatNumber(locale, value)} ${getDisplayCurrencyCode()}`;
export function formatAccountingNumber(locale: Locale, value: number, options: AccountingFormatOptions = {}) {
  return western(formatAccountingDecimal(localeTag(locale), value, { maximumFractionDigits: 0, ...options }));
}
export const formatAccountingMoney = (locale: Locale, value: number, options: AccountingFormatOptions = {}) =>
  `${formatAccountingNumber(locale, value, options)} ${getDisplayCurrencyCode()}`;
export const formatAccountingPercent = (locale: Locale, value: number, options: AccountingFormatOptions = {}) =>
  western(formatAccountingPercentage(localeTag(locale), value, { maximumFractionDigits: 0, ...options }));
export function formatDate(locale: Locale, value: Date | string | number, options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  return western(new Intl.DateTimeFormat(localeTag(locale), { ...options, numberingSystem: "latn" }).format(new Date(value)));
}
export const formatDateTime = (locale: Locale, value: Date | string | number) => formatDate(locale, value, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
