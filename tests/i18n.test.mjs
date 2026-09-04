import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arMessages, frMessages } from "../app/i18n/messages.ts";
import { translateApiError } from "../app/i18n/api-errors.ts";
import { DEFAULT_LOCALE, direction, LOCALE_COOKIE, normalizeLocale, supportedLocales } from "../app/i18n/locale.ts";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../app/conta-app.tsx");
const provider = read("../app/i18n/provider.tsx");
const layout = read("../app/layout.tsx");
const login = read("../app/login/page.tsx");

test("supported locales and default locale are explicit", () => {
  assert.deepEqual([...supportedLocales], ["ar", "fr"]);
  assert.equal(DEFAULT_LOCALE, "ar");
  assert.equal(normalizeLocale("invalid"), "ar");
});

test("locale direction maps Arabic to RTL and French to LTR", () => {
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("fr"), "ltr");
});

test("locale preference uses one durable cookie", () => {
  assert.equal(LOCALE_COOKIE, "alkarna_locale");
  assert.match(provider, /document\.cookie=`\$\{LOCALE_COOKIE\}=\$\{valid\}; Path=\/; Max-Age=31536000; SameSite=Lax`/);
});

test("Arabic and French dictionaries have an exhaustive non-empty contract", () => {
  assert.deepEqual(Object.keys(frMessages).sort(), Object.keys(arMessages).sort());
  for (const [key, value] of Object.entries(frMessages)) {
    assert.ok(value.trim(), `empty French value: ${key}`);
    assert.doesNotMatch(value, /\[FR\]/, `placeholder in: ${key}`);
  }
});

test("every statically translated application key exists in French", () => {
  const used = [...app.matchAll(/tr\(("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1]));
  for (const key of used) assert.ok(frMessages[key]?.trim(), `missing French UI key: ${key}`);
  assert.match(read("../app/i18n/messages.ts"), /Missing French translation/);
});

test("language switching is available in the shell and before authentication or activation", () => {
  assert.match(app, /className="language-switch soft"/);
  assert.match(app, /unlicensed-shell[\s\S]*language-switch/);
  assert.match(login, /className="language-switch soft"/);
  assert.match(app, /<Globe\/>/);
});

test("root language and direction are server-rendered from the Next cookie", () => {
  assert.match(layout, /normalizeLocale\(\(await cookies\(\)\)\.get\(LOCALE_COOKIE\)\?\.value\)/);
  assert.match(layout, /<html lang=\{locale\} dir=\{direction\(locale\)\}>/);
  assert.match(layout, /<LocaleProvider initialLocale=\{locale\}>/);
});

test("main page bar contains localized date and language controls", () => {
  const pageBar = app.slice(app.indexOf('<header className="page-bar">'), app.indexOf("</header>", app.indexOf('<header className="page-bar">')));
  assert.match(pageBar, /Intl|localizedDate/);
  assert.match(pageBar, /today-long/);
  assert.match(pageBar, /today-short/);
  assert.match(pageBar, /language-switch/);
});


test("translated metric and settings labels are never translated twice", () => {
  assert.match(app, /type PartyMetricStripItem = \{ labelKey: MessageKey/);
  assert.doesNotMatch(app, /labelKey:[^,}]*tr\(/);
  assert.doesNotMatch(app, /label:tr\("إعدادات عامة"\)/);
});

test("API errors have safe exact, dynamic and fallback French presentation", () => {
  assert.equal(translateApiError("fr", "اسم المستخدم غير صحيح"), "Nom d’utilisateur incorrect");
  assert.equal(translateApiError("fr", "الرصيد غير كافٍ في الصندوق"), "Solde insuffisant sur الصندوق");
  assert.equal(translateApiError("fr", "المخزون غير كافٍ للمنتج Thé"), "Stock insuffisant pour Thé");
  assert.match(translateApiError("fr", "خطأ جديد"), /erreur/i);
});

test("direction-aware desktop navigation and settings CSS regressions are guarded", () => {
  const css=read("../app/globals.css");
  assert.match(css, /sidebar nav \{[^}]*grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /minmax\(175px/);
  assert.match(css, /party-nav-menu > \.nav > span[^}]*white-space:\s*normal/);
  assert.match(css, /\.nav \{[^}]*min-height:\s*48px/);
  assert.match(css, /left:\s*50%;[\s\S]*transform:\s*translateX\(-50%\)/);
  assert.match(css, /users-permissions-layout\{[^}]*direction:inherit/);
  assert.match(css, /invoice-table-row > :last-child \{ border-inline-end: 0/);
  assert.doesNotMatch(app, /setRuntimeLocale|getRuntimeLocale/);
});
