"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { direction, LOCALE_COOKIE, normalizeLocale, type Locale } from "./locale";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatQuantity } from "./formatting";
import { translate, type MessageKey, type TranslationParams } from "./messages";

type I18n = { locale: Locale; dir: "rtl" | "ltr"; setLocale(locale: Locale): void; t(key: MessageKey, params?: TranslationParams): string; formatNumber(value: number): string; formatQuantity(value: number): string; formatMoney(value: number): string; formatDate(value: Date|string|number, options?: Intl.DateTimeFormatOptions): string; formatDateTime(value: Date|string|number): string };
const Context = createContext<I18n | null>(null);

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState(initialLocale);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = direction(locale); }, [locale]);
  const value = useMemo<I18n>(() => ({ locale, dir: direction(locale), setLocale(next) { const valid=normalizeLocale(next); document.documentElement.lang=valid; document.documentElement.dir=direction(valid); document.cookie=`${LOCALE_COOKIE}=${valid}; Path=/; Max-Age=31536000; SameSite=Lax`; setLocaleState(valid); }, t:(key,params)=>translate(locale,key,params), formatNumber:value=>formatNumber(locale,value), formatQuantity:value=>formatQuantity(locale,value), formatMoney:value=>formatMoney(locale,value), formatDate:(value,options)=>formatDate(locale,value,options), formatDateTime:value=>formatDateTime(locale,value) }), [locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useI18n() { const value=useContext(Context); if(!value) throw new Error("useI18n must be used inside LocaleProvider"); return value; }
