import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("overview separates current position from period performance", async () => {
  const [ui, reports] = await Promise.all([source("app/conta-app.tsx"), source("lib/reports.ts")]);
  assert.match(ui, /overview-summary-groups/);
  assert.match(ui, /tr\("الوضع الحالي"\)/);
  assert.match(ui, /tr\("أداء الفترة"\)/);
  for (const key of ["currentAccountsBalance","currentInventoryValue","currentReceivable","currentPayable","sales","purchases","expenses","netOperatingResult"]) assert.match(ui, new RegExp(`summary\.${key}`));
  assert.match(reports, /netOperatingResult:p\.profit-expenses/);
});

test("overview KPI details keep only calculation contributors in one signed money column",async()=>{const ui=await source("app/conta-app.tsx");for(const key of ["currentAccountsBalance","currentInventoryValue","currentReceivable","currentPayable","sales","purchases","expenses","netOperatingResult"])assert.match(ui,new RegExp(`openOverviewSummary\\("${key}"\\)`));assert.match(ui,/label:tr\("صافي المبيعات"\),value:sales/);assert.match(ui,/label:tr\("تكلفة المبيعات"\),value:-salesCost/);assert.match(ui,/label:tr\("إجمالي المصاريف"\),value:-expenses/);assert.doesNotMatch(ui,/excludedProfitMeta/);assert.doesNotMatch(ui,/impact:/);assert.doesNotMatch(ui,/الأثر في المجموع/);assert.match(ui,/overview-sales-total/);assert.match(ui,/overview-return-/);});

test("overview aggregate details link each contributing category to a traceable source",async()=>{
  const ui=await source("app/conta-app.tsx");
  assert.match(ui,/overview-sales-total[^\n]+source:\{kind:"report",reportType:"sales",period:committedPeriod\}/);
  assert.match(ui,/overview-purchases-total[^\n]+source:\{kind:"report",reportType:"purchases",period:committedPeriod\}/);
  assert.match(ui,/overview-expenses-total[^\n]+source:\{kind:"report",reportType:"expenses",period:committedPeriod\}/);
  assert.match(ui,/profit-sales-cost[^\n]+source:\{kind:"report",reportType:"sales",period:committedPeriod\}/);
  assert.match(ui,/overview-party-[^\n]+source:\{kind:"party",partyId:String\(party\.id\)\}/);
});


test("overview party rows expose debt direction independently of customer or supplier role", async () => {
  const ui=await source("app/conta-app.tsx");
  assert.match(ui,/reportNumber\(p\.payable\)>0\?<MoneyValue value=\{reportNumber\(p\.payable\)\} tone="negative"\/>:"—"/);
  assert.match(ui,/reportNumber\(p\.receivable\)>0\?<MoneyValue value=\{reportNumber\(p\.receivable\)\} tone="positive"\/>:"—"/);
  assert.doesNotMatch(ui,/p\.partyType==="supplier"\?<MoneyValue value=\{reportNumber\(p\.payable\)/);
  assert.doesNotMatch(ui,/p\.partyType==="customer"\?<MoneyValue value=\{reportNumber\(p\.receivable\)/);
});

test("party aggregate dues never net different parties against each other", async () => {
  const ui=await source("app/conta-app.tsx");
  assert.match(ui,/aggregateDues=allParties\.reduce/);
  assert.match(ui,/totals\.owedToUs\+=net/);
  assert.match(ui,/totals\.weOwe\+=Math\.abs\(net\)/);
  assert.match(ui,/PartyAggregateMetrics partyType=\{partyType\} metrics=\{aggregate\} owedToUs=\{aggregateDues\.owedToUs\} weOwe=\{aggregateDues\.weOwe\}/);
});


test("historical sales adjustments drill down to their exact source document", async () => {
  const ui=await source("app/conta-app.tsx");
  assert.match(ui,/kind: "document"; documentId: string/);
  assert.match(ui,/target\.kind === "document"[^\n]+openDoc\(target\.documentId\)/);
  assert.match(ui,/returnRows=salesRows\.filter\(row=>row\.kind==="return"\)/);
  assert.match(ui,/source:\{kind:"document" as const,documentId:String\(row\.documentId\)\}/);
  assert.doesNotMatch(ui,/overview-returns-total[^\n]+source:\{kind:"report",reportType:"sales"/);
});
