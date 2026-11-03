import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculatePartyFinancialSummaries } from "../app/party-metrics.ts";

const line = grossProfit => ({ grossProfit });
const doc = (kind, partyId, total, { status="posted", grossProfit=null }={}) => ({ kind, partyId, total, status, lines:[line(grossProfit)] });
const movement = (partyId, direction, amount, extra={}) => ({ partyId, direction, amount, ...extra });
const summary = (documents, movements, partyId) => calculatePartyFinancialSummaries(documents, movements).find(value => value.partyId === partyId);

test("customer cash sale counts trade and actual cash", () => {
  const value=summary([doc("sale","customer",1000,{grossProfit:300})],[movement("customer","in",1000)],"customer");
  assert.equal(value.customerTradeTotal,1000); assert.equal(value.cashIn,1000);
});
test("customer credit and later cash flows remain independent", () => {
  const credit=summary([doc("sale","customer",1000,{grossProfit:300})],[],"customer");
  assert.equal(credit.customerTradeTotal,1000); assert.equal(credit.cashIn,0);
  const later=summary([doc("sale","customer",1000,{grossProfit:300})],[movement("customer","in",400),movement("customer","out",75)],"customer");
  assert.equal(later.cashIn,400); assert.equal(later.cashOut,75);
});
test("reversed and reversal audit movements never re-enter party cash totals", () => {
  const value=summary([], [movement("customer","in",100),movement("customer","out",100,{status:"reversed"}),movement("customer","out",100,{isReversal:true})], "customer");
  assert.equal(value.cashIn,100); assert.equal(value.cashOut,0);
});
test("legacy return records preserve historical customer totals and represented gross profit, while voids and legacy missing profit are safe", () => {
  const value=summary([doc("sale","customer",1000,{grossProfit:300}),doc("return","customer",250,{grossProfit:80}),doc("sale","customer",900,{status:"voided",grossProfit:400}),doc("sale","customer",10)],[],"customer");
  assert.equal(value.customerTradeTotal,760); assert.equal(value.customerGrossProfit,220);
});
test("supplier cash purchase counts trade, cash out, and invoice", () => {
  const value=summary([doc("purchase","supplier",1000)],[movement("supplier","out",1000)],"supplier");
  assert.equal(value.supplierTradeTotal,1000); assert.equal(value.cashOut,1000); assert.equal(value.supplierInvoiceCount,1);
});
test("a legacy supplier return reduces purchase trade only and preserves cash evidence, invoice count and input", () => {
  const documents=[{...doc("purchase","supplier",200),id:"buy"},{...doc("return","supplier",100,{grossProfit:20}),id:"return",parentDocumentId:"buy"}],movements=[movement("supplier","out",200),movement("supplier","in",100)],before=structuredClone({documents,movements});
  const value=summary(documents,movements,"supplier");assert.equal(value.supplierTradeTotal,100);assert.equal(value.supplierInvoiceCount,1);assert.equal(value.customerTradeTotal,0);assert.equal(value.customerGrossProfit,0);assert.equal(value.cashOut,200);assert.equal(value.cashIn,100);assert.deepEqual({documents,movements},before);
});
test("a copied legacy customer return retains its explicit represented profit instead of being recosted as a discounted full sale", () => {
  const sale={...doc("sale","customer",100),id:"sale",lines:[{quantity:2,unitPrice:50,lineTotal:100,costAtSale:30,grossProfit:40}]},returned={...doc("return","customer",25),id:"return",parentDocumentId:"sale",lines:[{...sale.lines[0],grossProfit:10}]},before=structuredClone([sale,returned]);
  const value=summary([sale,returned],[],"customer");assert.equal(value.customerTradeTotal,75);assert.equal(value.customerGrossProfit,30);assert.deepEqual([sale,returned],before);
});
test("net profit already saved by owner recovery is not discounted twice and ordinary undiscounted profit snapshots remain authoritative", () => {
  const recovered={...doc("sale","customer",140),lines:[{quantity:1,unitPrice:150,lineTotal:150,costAtSale:100,grossProfit:40,saleCostRecovery:{version:1,action:"set-reviewed-cost",sourceType:"owner-reviewed"}}]},before=structuredClone(recovered);
  assert.equal(summary([recovered],[],"customer").customerGrossProfit,40);assert.deepEqual(recovered,before);
  const ordinary={...doc("sale","customer",100),lines:[{quantity:1,unitPrice:100,lineTotal:100,costAtSale:60,grossProfit:15}]};assert.equal(summary([ordinary],[],"customer").customerGrossProfit,15);
});
test("supplier credit, later payment, receipt, posted invoice count, and void exclusion", () => {
  const value=summary([doc("purchase","supplier",1000),doc("purchase","supplier",500),doc("purchase","supplier",700,{status:"voided"})],[movement("supplier","out",400),movement("supplier","in",60)],"supplier");
  assert.equal(value.supplierTradeTotal,1500); assert.equal(value.cashOut,400); assert.equal(value.cashIn,60); assert.equal(value.supplierInvoiceCount,2);
});
test("unattributed financial movements are never assigned", () => {
  assert.deepEqual(calculatePartyFinancialSummaries([], [movement(null,"in",500)]), []);
});
test("bootstrap exposes aggregate summaries with party view while retaining raw movement bank gate", () => {
  const source=readFileSync(new URL("../app/api/bootstrap/route.ts",import.meta.url),"utf8");
  assert.match(source,/partyFinancialSummaries=partyAdmin\?/);
  assert.match(source,/customers\.view/); assert.match(source,/suppliers\.view/);
  assert.match(source,/financialMovements:bankAccess\?clean\(effectiveFinancialMovements\):\[\]/);
  assert.doesNotMatch(source,/financialMovements:partyAdmin/);
});
