import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatMoney as formatDomainMoney } from "../app/domain.ts";
import { formatMoney as formatLocalizedMoney } from "../app/i18n/formatting.ts";
import { DEFAULT_CURRENCY_CODE, defaultCurrencySettings, normalizeCurrencyCode, normalizeCurrencySettings, setDisplayCurrencyCode } from "../lib/currency-core.ts";

test("currency defaults to MRU and accepts exactly three Latin letters", () => {
  assert.equal(DEFAULT_CURRENCY_CODE, "MRU");
  assert.deepEqual(defaultCurrencySettings(), {code:"MRU",availableCodes:["MRU"]});
  assert.equal(normalizeCurrencyCode(" eur "), "EUR");
  assert.equal(normalizeCurrencyCode("EU"), null);
  assert.equal(normalizeCurrencyCode("€UR"), null);
});

test("perfume edition money formatters use the same configured currency without changing values", () => {
  try {
    setDisplayCurrencyCode("EUR");
    assert.equal(formatDomainMoney(1250), "1 250 EUR");
    assert.equal(formatLocalizedMoney("fr",1250), "1 250 EUR");
    assert.match(formatLocalizedMoney("ar",1250), / EUR$/);
  } finally {
    setDisplayCurrencyCode(DEFAULT_CURRENCY_CODE);
  }
});

test("legacy or incomplete currency settings safely normalize to MRU", () => {
  assert.deepEqual(normalizeCurrencySettings(null), {code:"MRU",availableCodes:["MRU"]});
  assert.deepEqual(normalizeCurrencySettings({code:"usd",availableCodes:["mru","eur"]}), {code:"USD",availableCodes:["MRU","EUR","USD"]});
});

test("MRU remains only the default and is not hard-coded in shared money formatters", async () => {
  const domain=await readFile(new URL("../app/domain.ts",import.meta.url),"utf8");
  const localized=await readFile(new URL("../app/i18n/formatting.ts",import.meta.url),"utf8");
  assert.doesNotMatch(domain,/\} MRU`| MRU"/);
  assert.doesNotMatch(localized,/\} MRU`| MRU"/);
  assert.match(domain,/getDisplayCurrencyCode\(\)/);
  assert.match(localized,/getDisplayCurrencyCode\(\)/);
});

test("currency selection persists immediately in perfume settings", async () => {
  const app=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(app,/const persistCurrency=async\(next:BootstrapData\["currency"\]\)=>/);
  assert.match(app,/fetch\("\/api\/settings\/currency"/);
  assert.match(app,/onChange=\{event=>void persistCurrency\(\{\.\.\.currency,code:event\.target\.value\}\)\}/);
  assert.match(app,/if\(await persistCurrency\(next\)\)setNewCurrencyCode\(""\)/);
  assert.match(app,/setDisplayCurrencyCode\(response\.currency\.code\)/);
  assert.match(app,/reload\(\{blocking:false\}\)/);
  const generalSettings=app.slice(app.indexOf("function GeneralSettings("),app.indexOf("function PrintSettingsPanel("));
  const generalSave=generalSettings.slice(generalSettings.indexOf("const save=async()=>"),generalSettings.indexOf('return <div className="general-settings">'));
  assert.doesNotMatch(generalSave,/\/api\/settings\/currency/);
});

test("bootstrap and settings UI use persisted currency settings", async () => {
  const bootstrap=await readFile(new URL("../app/api/bootstrap/route.ts",import.meta.url),"utf8");
  const app=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  const route=await readFile(new URL("../app/api/settings/currency/route.ts",import.meta.url),"utf8");
  assert.match(bootstrap,/getCurrencySettings\(db\)/);
  assert.match(bootstrap,/Response\.json\(\{ branding, currency,/);
  assert.match(app,/setDisplayCurrencyCode\(j\.currency\?\.code\)/);
  assert.match(app,/\/api\/settings\/currency/);
  assert.match(app,/tr\("العملة الافتراضية"\)/);
  assert.match(route,/settings\.branding\.manage/);
});

test("currency settings has its own grid area and does not disturb perfume-specific screens", async () => {
  const app=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  assert.match(app,/title=\{tr\("العملة"\)\} className="currency-settings"/);
  assert.match(app,/title=\{tr\("هوية المستندات"\)\} className="branding-settings"/);
  assert.match(css,/grid-template-areas:"business branding" "currency document" "print print"/);
  assert.match(css,/\.currency-settings\{grid-area:currency\}/);
  assert.match(css,/\.branding-settings\{grid-area:branding\}/);
  assert.match(css,/\.print-settings-panel\{grid-area:print\}/);
});
