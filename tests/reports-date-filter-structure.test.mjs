import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizePresentationSource } from "./presentation-source.mjs";

const app = normalizePresentationSource(readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const reports = app.slice(app.indexOf("function Reports"), app.indexOf("function PrintableDocument"));

test("dated reports keep apply inside the shared compact date control", () => {
  const normalToolbar = reports.slice(reports.lastIndexOf('return <section className="reports-workspace"'));
  assert.match(normalToolbar, /showDates&&<CompactDateRange[^>]*onApply=\{\(\)=>void applyDraftPeriod\(\)\}[^>]*onAllTime=\{\(\)=>void applyAllTime\(\)\}/);
  assert.match(normalToolbar, /!showDates&&<button className="primary"[^>]*>عرض<\/button>/);
  assert.doesNotMatch(normalToolbar, /showDates&&<CompactDateRange[^>]*\/>\}<button className="primary"[^>]*>عرض<\/button>/);
});

test("report toolbars cannot override compact date internals", () => {
  assert.doesNotMatch(css, /\.report-toolbar\s+(?:label|input)\s*\{/);
  assert.doesNotMatch(css, /\.report-toolbar\s+:is\([^}]*\b(?:label|input)\b/);
  assert.doesNotMatch(css, /\.comprehensive-report\s+\.overview-toolbar\s+label\s*\{/);
  assert.match(css, /\.report-toolbar>\.compact-date-range\{flex:0 0 auto\}/);
});

test("shared compact date geometry remains authoritative", () => {
  assert.match(css, /\.compact-date-range label\{[^}]*width:130px[^}]*min-width:130px[^}]*height:34px[^}]*border-radius:4px/);
  assert.match(css, /\.compact-date-range label span\{[^}]*width:24px[^}]*min-width:24px/);
  assert.match(css, /\.compact-date-range input\{[^}]*width:106px[^}]*border-radius:0/);
});
