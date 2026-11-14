import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("overview separates current position from period performance", async () => {
  const [ui, reports] = await Promise.all([source("app/conta-app.tsx"), source("lib/reports.ts")]);
  assert.match(ui, /overview-summary-groups/);
  assert.match(ui, /tr\("الوضع الحالي"\)/);
  assert.match(ui, /tr\("أداء الفترة"\)/);
  for (const key of ["currentAccountsBalance","currentInventoryValue","currentReceivable","currentPayable","sales","purchases","expenses","ownerAvailableProfit"]) assert.match(ui, new RegExp(`summary\.${key}`));
  assert.match(reports, /const netOperatingResult=p\.profit-expenses/);
  assert.match(reports, /ownerAvailableProfit:netOperatingResult-payroll\.reserveChange/);
});

test("overview KPI details keep only calculation contributors in one signed money column",async()=>{
  const ui=await source("app/conta-app.tsx");
  for(const key of ["currentAccountsBalance","currentInventoryValue","currentReceivable","currentPayable","sales","purchases","expenses","ownerAvailableProfit"])assert.match(ui,new RegExp(`openOverviewSummary\\("${key}"\\)`));
  const start=ui.indexOf('const openOverviewSummary='),details=ui.slice(start,ui.indexOf('if(type==="overview")',start));
  assert.match(details,/label:tr\("صافي المبيعات"\),value:reportNumber\(result\.summary\.sales\)/);
  assert.match(details,/label:tr\("تكلفة المبيعات"\),value:-reportNumber\(result\.summary\.salesCost\)/);
  assert.match(details,/label:tr\("المصاريف الأخرى"\),value:-\(expenses-workerExpense\)/);
  assert.match(details,/label:tr\("مصروف أجور العمال"\),value:-workerExpense/);
  assert.match(details,/label:tr\("تغير حقوق العمال خلال الفترة"\),value:-reserveChange/);
  assert.match(details,/total:reportNumber\(result\.summary\.ownerAvailableProfit\)/);
  assert.doesNotMatch(details,/value:-reportNumber\(result\.summary\.currentWorkers(?:Owed|UnpaidWages)\)/);
  assert.doesNotMatch(ui,/excludedProfitMeta/);assert.doesNotMatch(ui,/impact:/);assert.doesNotMatch(ui,/الأثر في المجموع/);assert.match(ui,/overview-sales-total/);assert.match(ui,/overview-return-/);
});

test("overview aggregate details link each contributing category to a traceable source",async()=>{
  const ui=await source("app/conta-app.tsx");
  assert.match(ui,/overview-sales-total[^\n]+source:\{kind:"report",reportType:"sales",period:committedPeriod\}/);
  assert.match(ui,/overview-purchases-total[^\n]+source:\{kind:"report",reportType:"purchases",period:committedPeriod\}/);
  assert.match(ui,/overview-other-expenses[^\n]+value:reportNumber\(result\.summary\.expenses\)-workerExpense,openDetail:openOtherExpenseSummary/);
  const otherExpenses=ui.slice(ui.indexOf('const openOtherExpenseSummary'),ui.indexOf('const openOverviewSummary='));
  assert.match(otherExpenses,/filter\(row=>row\.kind==="expense"\)/);
  assert.match(otherExpenses,/source: \{ kind: "document" as const, documentId: row\.documentId \}/);
  assert.match(ui,/overview-worker-expenses[^\n]+value:workerExpense,openDetail:openWorkerExpenseSummary/);
  assert.match(ui,/profit-sales-cost[^\n]+source:\{kind:"report",reportType:"sales",period:committedPeriod\}/);
  const start=ui.indexOf('const accountSummaryDetail ='),details=ui.slice(start,ui.indexOf('const openWorkerBalanceSummary',start));
  assert.match(ui,/reportAccountRoles = \["employee", "customer", "supplier"\]/);
  assert.match(details,/reportAccountRoles\.map\(role/);
  assert.match(details,/party\.partyType === role && reportNumber\(receivable \? party\.receivable : party\.payable\) > 0/);
  assert.match(details,/id: "overview-party-"\+key\+"-"\+String\(party\.id\)/);
  assert.match(details,/kind: "party" as const, partyId: String\(party\.partyId \?\? party\.id\)/);
  assert.match(details,/canUseCapability\(data\.principal,"employees\.view"\)[^\n]+kind: "employee" as const, employeeId: String\(party\.employeeId \?\? party\.partyId \?\? party\.id\)/);
  assert.match(ui,/target\.kind === "employee"[\s\S]*?can\("employees\.view"\) && await navigate\("employees"\)\) setEmployeeSourceId\(target\.employeeId\)/);
});


test("overview party rows expose debt direction independently of employee, customer or supplier role", async () => {
  const ui=await source("app/conta-app.tsx");
  const start=ui.indexOf('function OverviewAccounts('),accounts=ui.slice(start,ui.indexOf('function handleModalKeyboard',start));
  assert.match(accounts,/reportAccountRoles\.map\(role/);
  assert.match(accounts,/reportNumber\(account\.payable\) > 0 \? <MoneyValue value=\{reportNumber\(account\.payable\)\} tone="negative"\/> : "—"/);
  assert.match(accounts,/reportNumber\(account\.receivable\) > 0 \? <MoneyValue value=\{reportNumber\(account\.receivable\)\} tone="positive"\/> : "—"/);
  assert.doesNotMatch(accounts,/role\s*===\s*"supplier"\s*\?\s*<MoneyValue/);
  assert.doesNotMatch(accounts,/role\s*===\s*"customer"\s*\?\s*<MoneyValue/);
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
  assert.match(ui,/overview-return-[^\n]+source:\{kind:"document" as const,documentId:row\.documentId\}/);
  assert.doesNotMatch(ui,/overview-returns-total[^\n]+source:\{kind:"report",reportType:"sales"/);
});
