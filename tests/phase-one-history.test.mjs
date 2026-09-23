import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expenseAllTimeMode, expenseDateMode, expenseSearchMode, filterDocumentsByDate, localBusinessDay, rankExpenseDocuments, sortDocumentsBySequence } from "../app/history-filters.ts";

const document = (id, sequence, day) => ({ id, sequence, occurredAt: `${day}T12:00:00.000Z`, businessDate: day });

test("history date scope defaults can use today's local business day", () => {
  assert.match(localBusinessDay(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(filterDocumentsByDate([document("today", 1, localBusinessDay()), document("old", 2, "2020-01-01")], localBusinessDay(), localBusinessDay(), false)[0].id, "today");
});

test("all-time ignores dates and a subsequent date-mode filter applies immediately", () => {
  const docs = [document("new", 2, "2026-08-27"), document("old", 1, "2020-01-01")];
  assert.deepEqual(filterDocumentsByDate(docs, "2026-08-27", "2026-08-27", true).map(item => item.id), ["new", "old"]);
  assert.deepEqual(filterDocumentsByDate(docs, "2020-01-01", "2020-01-01", false).map(item => item.id), ["old"]);
});

test("invoice history has no 100-row cap and orders numeric sequences newest-first", () => {
  const docs = Array.from({ length: 125 }, (_, index) => document(String(index), index + 1, "2026-08-27"));
  const ordered = sortDocumentsBySequence([...docs, document("legacy-a", undefined, "2026-08-27"), document("legacy-b", undefined, "2026-08-27")]);
  assert.equal(ordered.length, 127);
  assert.equal(ordered[0].sequence, 125);
  assert.deepEqual(ordered.slice(-2).map(item => item.id), ["legacy-a", "legacy-b"]);
});

test("expense defaults and all-time controls remain explicit", () => {
  const source = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  const expenses = source.slice(source.indexOf("function Expenses"), source.indexOf("function Banks"));
  assert.match(expenses, /expense-date",localBusinessDay\(\)/);
  assert.match(expenses, /useState\(today\).*historyAllTime/s);
  assert.match(expenses, /allTime=\{historyAllTime&&!historyQuery\.trim\(\)\}/);
  assert.match(expenses, /onAllTime=\{\(\)=>applyExpenseFilters\(expenseAllTimeMode\(\)\)\}/);
});

test("expense search ranks exact numbers and closer titles before loose matches", () => {
  const docs = [
    { ...document("loose", 4, "2026-08-27"), kind: "expense", title: "فاتورة كهرباء المكتب", number: "EXP-4" },
    { ...document("prefix", 2, "2026-08-27"), kind: "expense", title: "كهرباء", number: "EXP-7" },
    { ...document("exact-number", 1, "2026-08-27"), kind: "expense", title: "إيجار", number: "EXP-2", sequence: 1 },
    { ...document("none", 9, "2026-08-27"), kind: "expense", title: "مياه", number: "EXP-9" },
  ];
  assert.deepEqual(rankExpenseDocuments(docs, "  كهرب  ").map(item => item.id), ["prefix", "loose"]);
  assert.equal(rankExpenseDocuments(docs, "EXP-2")[0].id, "exact-number");
});

test("expense search, date, and all-time actions switch explicit filter modes", () => {
  const initial = { query: "", from: "2026-08-28", to: "2026-08-28", allTime: false };
  assert.deepEqual(expenseSearchMode(initial, " كهرباء "), { query: " كهرباء ", from: "", to: "", allTime: true });
  assert.deepEqual(expenseDateMode({ query: "كهرباء", from: "", to: "", allTime: true }, "from", "2026-07-01"), { query: "", from: "2026-07-01", to: "", allTime: false });
  assert.deepEqual(expenseAllTimeMode(), { query: "", from: "", to: "", allTime: true });
});

test("product picker and document overlay regression checkpoints remain mounted", () => {
  const source = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  const picker = source.slice(source.indexOf("function ProductSearchPicker"), source.indexOf("const SearchProducts"));
  for (const behavior of ["barcode === term", 'data-hover-enter="select"', "onClick={() => add(product)}", "stockInWarehouse", "isProductExpired", "sellingPrice"]) assert.match(picker, new RegExp(behavior.replace(/[(){}]/g, "\\$&")));
  assert.match(source, /\{doc && <div className="modal-overlay"/);
  assert.doesNotMatch(source, /\) : doc \? \(/);
});


test("records workspace reads audit history instead of posted bootstrap documents",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),records=source.slice(source.indexOf("function Records"),source.indexOf("const reportNames"));assert.match(records,/\/api\/history\?/);assert.doesNotMatch(records,/status === "posted"/);assert.match(source,/resource=documents&id=/);});


test("records audit view paginates instead of silently stopping at 250 rows",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),records=source.slice(source.indexOf("function Records"),source.indexOf("const reportNames"));assert.match(records,/page:String\(page\),pageSize:"100"/);assert.match(records,/setTotalPages/);assert.match(records,/setPage\(current=>Math\.min\(totalPages,current\+1\)\)/);});
test("report rows can request their exact source document without granting a general history list",()=>{const source=readFileSync(new URL("../app/api/history/route.ts",import.meta.url),"utf8");assert.match(source,/reportDocumentLookup=resource==="documents"&&Boolean\(id\)&&hasCapability\(principal,"reports\.view"\)/);assert.match(source,/reportDocumentLookup\|\|canReadDocument/);});


test("records view exposes document stock and financial audit resources",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),records=source.slice(source.indexOf("function Records"),source.indexOf("const reportNames")),history=readFileSync(new URL("../app/api/history/route.ts",import.meta.url),"utf8");for(const resource of ["documents","stockMovements","financialMovements"])assert.match(records,new RegExp(resource));assert.match(history,/recordsAccess\|\|hasCapability\(principal,"warehouses\.inventory\.view"\)/);assert.match(history,/recordsAccess\|\|hasCapability\(principal,"banks\.movements\.view"\)/);});
