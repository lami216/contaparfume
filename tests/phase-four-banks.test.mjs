import test from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";import {bankScopeBreakdown,bankScopeMetrics,filterFinancialMovements,filterTransfers} from "../app/bank-filters.ts";
const movements=[{id:"1",paymentMethod:"a",type:"sale",occurredAt:"2026-08-10",amount:10},{id:"2",paymentMethod:"b",type:"expense",occurredAt:"2026-07-10",amount:4},{id:"3",paymentMethod:"a",type:"expense",occurredAt:"2026-08-12",amount:3}];
test("all-time and committed period scopes remain independent of account/type changes",()=>{assert.equal(filterFinancialMovements(movements,null).length,3);const period={from:"2026-08-01",to:"2026-08-31"};assert.equal(filterFinancialMovements(movements,period).length,2);assert.equal(filterFinancialMovements(movements,period,"a").length,2);assert.equal(filterFinancialMovements(movements,period,"a","sale").length,1);assert.equal(filterFinancialMovements(movements,null,"a","sale").length,1)});
test("bank summary keeps inactive non-archived balances, external cash movements, and net party debts",()=>{const accounts=[{id:"a",code:"a",balance:90,isActive:true},{id:"b",code:"b",balance:40,isActive:false}],rows=[{direction:"in",amount:100,type:"sale"},{direction:"out",amount:20,type:"expense"},{direction:"in",amount:50,type:"transfer-in"}];assert.deepEqual(bankScopeMetrics(accounts,rows,[{receivable:25,payable:5},{receivable:0,payable:10}]),{currentBalance:130,income:100,expenses:20,owedToUs:20,weOwe:10})});
test("transfer filters preserve committed period and both account directions",()=>{const rows=[{occurredAt:"2026-08-10",fromAccountId:"a",toAccountId:"b"},{occurredAt:"2026-08-11",fromAccountId:"b",toAccountId:"a"},{occurredAt:"2026-07-01",fromAccountId:"a",toAccountId:"b"}];assert.equal(filterTransfers(rows,{from:"2026-08-01",to:"2026-08-31"},"a","b").length,1)});
test("adjustment history and financial detail overlay remain explicit and mounted",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8");assert.match(source,/manual-deposit.*manual-withdrawal/);assert.match(source,/FinancialOperationDetail/);assert.match(source,/detail&&<FinancialOperationDetail/);assert.match(source,/createPortal\(<div className="modal-overlay"/) });
test("bank sections are parent navigation state rather than content tabs",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(source,/const bankNav/);assert.match(source,/\(view==="banks"&&item\.id===effectiveBankTab\)\|\|await navigate\("banks",\{replaceEditor:true\}\)\)setBankTab\(item\.id\)/);assert.doesNotMatch(banks,/className="bank-tabs"/)});
test("bank transfer and adjustment workspaces use explicit split regions and logical form rows",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/bank-panel-centered-legend/);assert.match(banks,/transfer-account-row/);assert.match(banks,/transfer-detail-row/);assert.match(banks,/adjustment-account-row/);assert.match(banks,/adjustment-detail-row/);assert.match(banks,/bank-history-date-row/);assert.match(banks,/bank-history-select-row/);assert.match(css,/\.bank-tab-transfers,\.bank-tab-adjustment\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)[^}]*grid-template-areas:"operation history"/);assert.match(css,/\.bank-tab-transfers>\.bank-operation,\.bank-tab-adjustment>\.bank-operation\{grid-area:operation\}/);assert.match(css,/\.bank-tab-transfers>\.bank-history,\.bank-tab-adjustment>\.bank-history\{grid-area:history\}/);assert.match(css,/\.bank-panel-centered-legend>legend\{[^}]*margin-inline:auto/);assert.doesNotMatch(css,/\.erp-fieldset>legend\{[^}]*margin-inline:auto/)});
test("bank record amount tones are scoped to amount cells and derive from direction",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/m\.direction==="in"\?"bank-amount-positive":"bank-amount-negative"/);assert.match(banks,/className="num-cell bank-amount-neutral"/);assert.match(css,/\.bank-amount-positive\{color:#15803d/);assert.match(css,/\.bank-amount-negative\{color:#b91c1c/);assert.match(css,/\.bank-amount-neutral\{color:var\(--ink\)/);assert.doesNotMatch(css,/(?:tr|tbody)\.(?:bank-amount-positive|bank-amount-negative)/)});


test("opening-balance corrections do not inflate bank income or expenses",()=>{const accounts=[{id:"a",code:"a",balance:150,isActive:true}],rows=[{direction:"in",amount:50,type:"opening-balance-correction"},{direction:"out",amount:10,type:"balance-correction"},{direction:"in",amount:20,type:"sale"}];assert.deepEqual(bankScopeMetrics(accounts,rows,[]),{currentBalance:150,income:20,expenses:0,owedToUs:0,weOwe:0})});
test("edit-only bank permissions expose edit forms without exposing new-operation forms",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/canTransferCreate\|\|\(Boolean\(editingTransferId\)&&canTransferEdit\)/);assert.match(banks,/canAdjustmentCreate\|\|\(Boolean\(editingAdjustmentId\)&&canAdjustmentEdit\)/);assert.match(banks,/editingTransferId\?!canTransferEdit:!canTransferCreate/);assert.match(banks,/editingAdjustmentId\?!canAdjustmentEdit:!canAdjustmentCreate/);});
test("bank movement filter does not offer opening rows that the operational list intentionally excludes",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/filter\(\(\[value\]\)=>!\["opening-balance","opening-balance-correction"\]\.includes\(value\)\)/);});


test("historical bank editors preserve archived account ids instead of replacing them with an empty selector",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/const accountId=.*data\.paymentAccounts\.find/);assert.match(banks,/historicalAccounts=\(ids:string\[\]\)/);assert.doesNotMatch(banks,/activeAccountId/);});

test("bank summary breakdown reconciles every card and keeps zero-value source kinds visible",()=>{
  const accounts=[{id:"a",name:"A",balance:10,isActive:true},{id:"zero",name:"Zero",balance:0,isActive:false},{id:"archived",name:"Old",balance:99,isArchived:true}];
  const rows=[
    {id:"sale",direction:"in",amount:25,type:"sale",paymentMethod:"a",documentNumber:"S-1",occurredAt:"2026-08-01",partyId:null},
    {id:"expense",direction:"out",amount:7,type:"expense",paymentMethod:"a",documentNumber:"E-1",occurredAt:"2026-08-02",partyId:null},
    {id:"customer-receipt",direction:"in",amount:6,type:"party-receipt",paymentMethod:"a",documentNumber:"P-1",occurredAt:"2026-08-03",partyId:"c"},
    {id:"supplier-receipt",direction:"in",amount:3,type:"party-receipt",paymentMethod:"a",documentNumber:"P-2",occurredAt:"2026-08-04",partyId:"s"},
    {id:"customer-payment",direction:"out",amount:4,type:"party-payment",paymentMethod:"a",documentNumber:"P-3",occurredAt:"2026-08-05",partyId:"c"},
    {id:"supplier-payment",direction:"out",amount:5,type:"party-payment",paymentMethod:"a",documentNumber:"P-4",occurredAt:"2026-08-06",partyId:"s"},
  ];
  const parties=[{id:"c",name:"C",partyType:"customer",receivable:12,payable:2},{id:"s",name:"S",partyType:"supplier",receivable:0,payable:5},{id:"z",name:"Z",partyType:"customer",receivable:0,payable:0}];
  const metrics=bankScopeMetrics(accounts,rows,parties),details=bankScopeBreakdown(accounts,rows,parties);
  assert.equal(details.accounts.reduce((sum,row)=>sum+row.value,0),metrics.currentBalance);
  assert.equal(details.income.reduce((sum,row)=>sum+row.value,0),metrics.income);
  assert.equal(details.expenses.reduce((sum,row)=>sum+row.value,0),metrics.expenses);
  assert.equal(details.parties.reduce((sum,row)=>sum+row.owedToUs,0),metrics.owedToUs);
  assert.equal(details.parties.reduce((sum,row)=>sum+row.weOwe,0),metrics.weOwe);
  assert.deepEqual(details.income.map(row=>row.kind),["sale","party-receipt:customer","party-receipt:supplier","manual-deposit"]);
  assert.deepEqual(details.expenses.map(row=>row.kind),["purchase","expense","party-payment:customer","party-payment:supplier","manual-withdrawal"]);
  assert.deepEqual(details.income.filter(row=>row.kind.startsWith("party-receipt:")).map(row=>[row.kind,row.count,row.value]),[["party-receipt:customer",1,6],["party-receipt:supplier",1,3]]);
  assert.deepEqual(details.expenses.filter(row=>row.kind.startsWith("party-payment:")).map(row=>[row.kind,row.count,row.value]),[["party-payment:customer",1,4],["party-payment:supplier",1,5]]);
  assert.ok(details.expenses.some(row=>row.kind==="manual-withdrawal"&&row.value===0&&row.count===0));
  assert.equal(details.income.some(row=>row.kind==="purchase"),false);
  assert.equal(details.expenses.some(row=>row.kind==="sale"),false);
  assert.deepEqual(details.income.filter(row=>row.kind==="sale").map(row=>[row.count,row.value]),[[1,25]]);
  assert.ok(details.accounts.some(row=>row.name==="Zero"&&row.value===0));
  assert.ok(details.parties.some(row=>row.name==="Z"&&row.owedToUs===0&&row.weOwe===0));
});

test("bank summary cards are clickable and use the shared reconciliation dialog",()=>{const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));assert.match(banks,/buildAccountBreakdown=\(\)=>bankScopeBreakdown/);assert.match(banks,/setSummaryDetail\(accountBalanceDetail\(\)\)/);assert.match(banks,/movementSummaryDetail\("in"\)/);assert.match(banks,/debtDetail\("owedToUs"\)/);assert.match(source,/function SummaryBreakdownDialog/);});

test("bank summary details link category totals to their source areas",()=>{
  const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));
  assert.match(banks,/kind==="sale"\)return\{kind:"report",reportType:"sales",period:null\}/);
  assert.match(banks,/kind==="purchase"\)return\{kind:"report",reportType:"purchases",period:null\}/);
  assert.match(banks,/kind==="expense"\)return\{kind:"report",reportType:"expenses",period:null\}/);
  assert.match(banks,/party-receipt:customer/);
  assert.match(banks,/party-payment:supplier/);
  assert.match(banks,/openSource=\{openSource\}/);
  assert.match(banks,/sourceRequest\.kind==="transfer"/);
});


test("payment-account landing view defers unrelated bank histories and breakdown expansion work",()=>{
  const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));
  assert.match(banks,/operationalMovements=useMemo\(\(\)=>tab==="movements"\|\|tab==="adjustment"\?/);
  assert.match(banks,/movements=useMemo\(\(\)=>tab==="movements"\?/);
  assert.match(banks,/transfers=useMemo\(\(\)=>tab==="transfers"\?/);
  assert.match(banks,/adjustments=useMemo\(\(\)=>tab==="adjustment"\?/);
  assert.match(banks,/accountSummary=useMemo\(\(\)=>bankScopeMetrics/);
  assert.match(banks,/buildAccountBreakdown=\(\)=>bankScopeBreakdown/);
  assert.doesNotMatch(banks,/accountBreakdown=bankScopeBreakdown/);
});

test("expense and payable breakdowns use negative money tone while debt lists stay compact",()=>{
  const source=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),banks=source.slice(source.indexOf("function Banks"),source.indexOf("function PaymentAccountDialog"));
  assert.match(banks,/tone:MoneyTone=direction==="in"\?"positive":"negative"/);
  assert.match(banks,/tone:MoneyTone=side==="owedToUs"\?"positive":"negative"/);
  assert.match(banks,/compact:true/);
  assert.match(source,/row\.tone/);
  assert.match(source,/detail\.tone/);
  assert.match(css,/\.summary-breakdown-modal\.summary-breakdown-compact\{width:min\(640px,calc\(100vw - 28px\)\)/);
  assert.match(css,/\.summary-breakdown-compact \.summary-breakdown-label\{display:flex/);
});
