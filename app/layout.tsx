import type { Metadata } from "next";
import { cookies } from "next/headers";
import { APP_NAME } from "../lib/app-brand";
import { LocaleProvider } from "./i18n/provider";
import { direction, LOCALE_COOKIE, normalizeLocale } from "./i18n/locale";
import "./globals.css";
import "./perfume-ui-fixes.css";
import "./compact-navigation.css";

export async function generateMetadata(): Promise<Metadata> {
 const locale=normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
 const tagline=locale==="ar"?"العطور":"Parfums";
 return { title: `${APP_NAME} — ${tagline}`, description: locale==="ar"?"نظام محاسبة وإدارة للعطور والمبيعات والمشتريات والمخزون والحسابات.":"Système de gestion et comptabilité pour parfumeries : ventes, achats, stock et comptes.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/alkarna-logo.png",
    shortcut: "/alkarna-logo.png",
  },
 };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale=normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale} dir={direction(locale)}>
      <body><LocaleProvider initialLocale={locale}>{children}</LocaleProvider></body>
    </html>
  );
}
