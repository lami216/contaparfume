import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePresentationSource } from "./presentation-source.mjs";

const app = normalizePresentationSource(readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const brand = readFileSync(new URL("../lib/app-brand.ts", import.meta.url), "utf8");

test("party list and account summaries share one four-item metric strip", () => {
  assert.match(app, /function PartyMetricStrip/);
  assert.match(app, /return <PartyMetricStrip items=\{items\} aggregate\/>/);
  assert.match(app, /<PartyMetricStrip items=\{\[/);
  const aggregate = app.slice(app.indexOf("function PartyAggregateMetrics"), app.indexOf("function Parties"));
  assert.equal((aggregate.match(/labelKey:/g) ?? []).length, 8);
  assert.doesNotMatch(css, /party-list-metrics/);
  assert.match(css, /\.party-trade-metrics\{flex-wrap:nowrap\}/);
  assert.match(css, /@media\(max-width:760px\)\{\.party-trade-metrics\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
});

test("visible product branding uses the shared Arabic identity and logo path", () => {
  assert.match(brand, /APP_NAME = "الكرنه"/);
  assert.match(brand, /APP_LOGO_PATH = "\/alkarna-logo\.png"/);
  assert.match(app, /className="brand-logo"><img src=\{APP_LOGO_PATH\}/);
  assert.match(login, /<img src=\{APP_LOGO_PATH\}/);
  assert.match(layout, /title: `\$\{APP_NAME\} — \$\{tagline\}`/);
  assert.match(layout, /locale==="ar"\?"نظام المتجر":"Gestion du magasin"/);
  assert.doesNotMatch(login, />Conta<|>C</);
  assert.match(app, /تم إنشاء هذا المستند بواسطة \{APP_NAME\}/);
});

test("compatibility storage namespace remains unchanged", () => {
  assert.match(app, /sessionStorage\.getItem\(`conta:\$\{key\}`\)/);
  assert.match(app, /sessionStorage\.setItem\(`conta:\$\{key\}`/);
});
