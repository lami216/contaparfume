import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validateRequiredDateRange, MAX_REPORT_RANGE_DAYS } from "../app/date-range-validation.ts";
import { parseReportFilters } from "../lib/reports.ts";

test("required date ranges reject empty, malformed, reversed and overlong periods", () => {
  assert.equal(validateRequiredDateRange("", ""), "missing");
  assert.equal(validateRequiredDateRange("2026-09-10", ""), "missing");
  assert.equal(validateRequiredDateRange("", "2026-09-10"), "missing");
  assert.equal(validateRequiredDateRange("2026-02-30", "2026-09-10"), "invalid");
  assert.equal(validateRequiredDateRange("not-a-date", "2026-09-10"), "invalid");
  assert.equal(validateRequiredDateRange("2026-09-11", "2026-09-10"), "reversed");
  assert.equal(validateRequiredDateRange("2010-01-01", "2026-09-10"), "too-long");
  assert.equal(validateRequiredDateRange("2026-09-10", "2026-09-10"), null);
  assert.equal(MAX_REPORT_RANGE_DAYS, 3660);
});

test("report API remains a second line of defense for missing dates while all-time is valid", () => {
  assert.throws(() => parseReportFilters(new URL("http://local/api/reports?type=sales&from=&to=")), /الفترة مطلوبة/);
  const all = parseReportFilters(new URL("http://local/api/reports?type=sales&allTime=true"));
  assert.equal(all.allTime, true);
});

test("filtered sales UI displays line revenue total without overwriting unit price semantics", () => {
  const source = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  assert.match(source, /sales:productId\?\[\["number"[\s\S]*?\["revenue",tr\("قيمة البيع"\),"money"\]/);
  assert.doesNotMatch(source, /sales:productId\?\[\["number"[\s\S]{0,500}?\["unitPrice",tr\("سعر البيع"\),"money"\]/);
  assert.match(source, /validateRequiredDateRange\(from,to\)/);
  assert.match(source, /const applyDraftPeriod=\(\)=>\{const issue=validateRequiredDateRange\(draftFrom,draftTo\)/);
});

test("desktop renderer has a local recovery path instead of leaving Chromium raw error UI", () => {
  const source = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.match(source, /did-fail-load/);
  assert.match(source, /تعذر تحميل الصفحة داخل الكرنه/);
  assert.match(source, /إعادة المحاولة/);
});
