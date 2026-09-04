import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildReportFooterMetrics } from "../app/report-footer.ts";
import { isOperatingFinancialMovement } from "../lib/reports.ts";

const result = summary => ({ report:"sales",from:null,to:null,summary,rows:[],meta:{page:1,pageSize:0,totalRows:0,totalPages:1} });
const keys = (type,summary={},context={}) => buildReportFooterMetrics({type,result:result(summary),...context}).map(x=>x.key);
test("visible reports expose exact semantic footer keys",()=>{
  assert.deepEqual(keys("sales"),["netSales","cost","profit","margin"]);
  assert.deepEqual(keys("purchases"),["total","paid","due","count"]);
  assert.deepEqual(keys("purchases",{total:100,quantity:4},{productFiltered:true}),["total","quantity","averagePurchasePrice","count"]);
  assert.deepEqual(keys("product-sales"),["sales","profit","quantity","products"]);
  assert.deepEqual(keys("stock"),["incoming","outgoing","netChange","movements"]);
  assert.deepEqual(keys("debts"),["receivable","payable","net","count"]);
  assert.deepEqual(keys("party-ledger"),["tradeTotal","debitTotal","creditTotal","net"]);
  assert.deepEqual(keys("financial"),["businessIncoming","businessOutgoing","businessNet","balanceNet"]);
  assert.deepEqual(keys("expenses"),["total","recurringTotal","oneOffTotal","count"]);
});
test("footer tones follow business meaning and meaningful zero stays visible",()=>{
  const debts=buildReportFooterMetrics({type:"debts",result:result({receivable:20,payable:10,net:10,count:2})});
  assert.deepEqual(debts.map(x=>x.tone),["positive","negative","positive","neutral"]);
  assert.equal(buildReportFooterMetrics({type:"debts",result:result({net:-1})})[2].tone,"negative");
  assert.deepEqual(buildReportFooterMetrics({type:"stock",result:result({})}).slice(0,2).map(x=>x.tone),["neutral","neutral"]);
  assert.equal(buildReportFooterMetrics({type:"purchases",result:result({})})[0].tone,"neutral");
  assert.equal(buildReportFooterMetrics({type:"expenses",result:result({})})[0].tone,"negative");
  assert.equal(buildReportFooterMetrics({type:"sales",result:result({profit:-2})})[2].tone,"negative");
  const balance=buildReportFooterMetrics({type:"party-ledger",result:result({net:0})})[3]; assert.equal(balance.value,0); assert.equal(balance.note,"متوازن");
});
test("product purchase footer never presents invoice payment allocation",()=>{ const metrics=buildReportFooterMetrics({type:"purchases",result:result({total:100,quantity:4,paid:80,due:20,count:1}),productFiltered:true}); assert.equal(metrics[2].value,25); assert.ok(!metrics.some(x=>["paid","due"].includes(x.key))); });
test("financial operating classification excludes balance administration and transfers",()=>{ for(const type of ["transfer-in","transfer-out","opening-balance","manual-deposit","manual-withdrawal","balance-correction"]) assert.equal(isOperatingFinancialMovement(type),false); for(const type of ["sale","purchase","expense","party-receipt","party-payment"]) assert.equal(isOperatingFinancialMovement(type),true); });
test("party ledger composite filter has stable geometry and both roles",async()=>{ const [css,ui]=await Promise.all([readFile(new URL("../app/globals.css",import.meta.url),"utf8"),readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")]); assert.match(css,/\.report-filters>\.party-ledger-filter\{max-width:none/); assert.match(css,/grid-template-columns:180px minmax\(280px,340px\)/); assert.match(css,/\.party-ledger-filter \.combobox\{width:100%;min-width:280px/); assert.match(ui,/العملاء/); assert.match(ui,/الموردون/); });
