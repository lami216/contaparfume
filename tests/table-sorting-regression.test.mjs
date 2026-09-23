import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compareTableValues, sortTableRows } from "../app/table-sorting.tsx";

const values = (input, type, direction = "asc", locale) => sortTableRows(
  input.map((value, index) => ({ id: index, value })),
  { key: "value", direction },
  [{ key: "value", type, get: row => row.value }],
  locale,
).map(row => row.value);

const ascendingNumbers = [1, 2, 3, 9, 10, 11, 20, 99, 100, 101];

test("shared sorter orders numeric values and numeric strings numerically", () => {
  assert.deepEqual(values([100, 2, 11, 1, 101, 3, 20, 10, 99, 9], "number"), ascendingNumbers);
  assert.deepEqual(values([100, 2, 11, 1, 101, 3, 20, 10, 99, 9], "number", "desc"), [...ascendingNumbers].reverse());
  assert.deepEqual(values(["100", "2", "10", "1"], "number"), ["1", "2", "10", "100"]);
  assert.deepEqual(values(["10000", "500", "2000"], "money"), ["500", "2000", "10000"]);
});

test("natural text sorting handles numeric references, SKU, barcode and Arabic locale", () => {
  assert.deepEqual(values(["SAL-100", "SAL-2", "SAL-10", "SAL-1"], "text"), ["SAL-1", "SAL-2", "SAL-10", "SAL-100"]);
  assert.deepEqual(values(["TRF-100", "TRF-2", "TRF-10", "TRF-1"], "text"), ["TRF-1", "TRF-2", "TRF-10", "TRF-100"]);
  assert.deepEqual(values(["100", "2", "10", "1"], "text"), ["1", "2", "10", "100"]);
  assert.deepEqual(values(["629100", "6292", "62910", "6291"], "text"), ["6291", "6292", "62910", "629100"]);
  assert.deepEqual(values(["منتج 10", "منتج 2", "منتج 1"], "text", "asc", "ar"), ["منتج 1", "منتج 2", "منتج 10"]);
});

test("number and money columns fall back to natural sorting instead of producing NaN", () => {
  assert.deepEqual(values(["TRF-100", "TRF-2", "TRF-10", "TRF-1"], "number"), ["TRF-1", "TRF-2", "TRF-10", "TRF-100"]);
  assert.deepEqual(values(["ADJ-100", "ADJ-2", "ADJ-10", "ADJ-1"], "number"), ["ADJ-1", "ADJ-2", "ADJ-10", "ADJ-100"]);
  assert.ok(Number.isFinite(compareTableValues("TRF-1", "TRF-10", "number", "asc")));
  assert.ok(Number.isFinite(compareTableValues("not-money", "200", "money", "asc")));
});

test("dates use timestamps and invalid dates never leak NaN", () => {
  const input = ["2026-09-10T00:00:00.000Z", "2025-12-31T23:59:59.000Z", "2026-01-01T00:00:00.000Z"];
  assert.deepEqual(values(input, "date"), [input[1], input[2], input[0]]);
  assert.deepEqual(values(input, "date", "desc"), [input[0], input[2], input[1]]);
  assert.ok(Number.isFinite(compareTableValues("invalid-date-2", "invalid-date-10", "date", "asc")));
});

test("null and empty values are stable and always sort after real values", () => {
  const input = [null, "10", "", "2", undefined, "   ", "1"];
  assert.deepEqual(values(input, "number", "asc").slice(0, 3), ["1", "2", "10"]);
  assert.deepEqual(values(input, "number", "desc").slice(0, 3), ["10", "2", "1"]);
  assert.deepEqual(values(input, "number", "asc").slice(3), [null, "", undefined, "   "]);
  assert.deepEqual(values(input, "number", "desc").slice(3), [null, "", undefined, "   "]);
});

test("mixed numeric and alphanumeric document values remain deterministic", () => {
  const input = ["TRF-10", "2", "TRF-2", "10", "1", "TRF-1"];
  const asc = values(input, "number");
  const desc = values(input, "number", "desc");
  assert.deepEqual([...desc].reverse(), asc);
  assert.deepEqual(new Set(asc), new Set(input));
  for (let index = 1; index < asc.length; index++) {
    assert.ok(compareTableValues(asc[index - 1], asc[index], "number", "asc") <= 0);
  }
});

test("representative report and screen columns use the same central semantics", () => {
  const invoiceRows = [100, 2, 10, 1].map(number => ({ number: String(number) }));
  const invoiceColumn = [{ key: "number", type: "number", get: row => row.number }];
  assert.deepEqual(sortTableRows(invoiceRows, { key: "number", direction: "asc" }, invoiceColumn).map(row => row.number), ["1", "2", "10", "100"]);

  const referenceRows = ["TRF-100", "TRF-2", "TRF-10", "TRF-1"].map(documentNumber => ({ documentNumber }));
  const referenceColumn = [{ key: "documentNumber", type: "text", get: row => row.documentNumber }];
  assert.deepEqual(sortTableRows(referenceRows, { key: "documentNumber", direction: "asc" }, referenceColumn).map(row => row.documentNumber), ["TRF-1", "TRF-2", "TRF-10", "TRF-100"]);

  const monetaryRows = [10000, 500, 2000].map(total => ({ total }));
  assert.deepEqual(sortTableRows(monetaryRows, { key: "total", direction: "asc" }, [{ key: "total", type: "money", get: row => row.total }]).map(row => row.total), [500, 2000, 10000]);
});

test("sorting-enabled screens keep the shared sorter while reports use global server sorting", () => {
  const source = fs.readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  assert.match(source, /q\.set\("sortKey",requestedSort\.key\)/);
  assert.match(source, /q\.set\("sortDirection",requestedSort\.direction\)/);
  assert.match(source, /toggleReportSort=.*runReport\(committedPeriod,1,next\)/);
  assert.doesNotMatch(source, /numeric=typeof leftValue===\"number\"\|\|typeof rightValue===\"number\"/);
  assert.match(source, /sales:productId\?\[\[\"number\",tr\(\"رقم الفاتورة\"\),\"number\"\]/);
  assert.match(source, /purchases:productId\?\[\[\"number\",tr\(\"رقم الفاتورة\"\),\"number\"\]/);
  assert.match(source, /expenses:\[\[\"occurredAt\",tr\(\"التاريخ\"\),\"date\"\][\s\S]{0,700}\[\"number\",tr\(\"المستند\"\),\"number\"\]/);
  assert.match(source, /stock:\[\[\"occurredAt\",tr\(\"التاريخ\"\),\"date\"\][\s\S]{0,900}\[\"documentNumber\",tr\(\"المستند\"\),\"text\"\]/);
  assert.match(source, /party-ledger\":\[\[\"occurredAt\",tr\(\"التاريخ\"\),\"date\"\][\s\S]{0,900}\[\"documentNumber\",tr\(\"رقم المستند\"\),\"text\"\]/);
  assert.match(source, /financial:\[\[\"occurredAt\",tr\(\"التاريخ\"\),\"date\"\][\s\S]{0,900}\[\"documentNumber\",tr\(\"المستند\"\),\"text\"\]/);
  assert.match(source, /movementColumns=useMemo\(\(\)=>\[[\s\S]*?key:\"number\",type:\"number\" as const[\s\S]*?useSortableRows\(filteredMovementDocs,movementColumns\)/);
  assert.match(source, /transferColumns=useMemo\(\(\)=>\[[\s\S]*?key:\"number\",type:\"number\" as const[\s\S]*?useSortableRows\(transfers,transferColumns\)/);
  assert.match(source, /key:\"reference\",type:\"text\" as const[\s\S]*?useSortableRows\(transfers,transferColumns\)/);
  assert.match(source, /key:\"document\",type:\"text\" as const[\s\S]*?useSortableRows\(movements,movementColumns\)/);
  assert.match(source, /function InvoiceQuickBrowser[\s\S]*?useSortableRows\(visible,columns\)/);
  assert.match(source, /function Recent[\s\S]*?useSortableRows\(visibleDocs,columns\)/);
  assert.match(source, /productSortColumns=useMemo[\s\S]*?sortTableRows\(filteredProducts,sort,productSortColumns\)/);
});
