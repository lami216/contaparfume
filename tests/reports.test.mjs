import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { buildReport, parseReportFilters } from "../lib/reports.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";
const parse = query => parseReportFilters(new URL(`http://localhost/api/reports?${query}`));
let harness, db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
beforeEach(async()=>{await harness.reset()});
after(async()=>{await harness.close()});
const filters=(type,extra={})=>({type,from:"2026-08-01",to:"2026-08-31",page:1,pageSize:100,...extra});
const line=(id,productId,quantity,unitPrice,costAtSale)=>({id,productId,description:productId,quantity,unitPrice,lineTotal:quantity*unitPrice,...(costAtSale===undefined?{}:{costAtSale})});
const doc=(id,kind,date,lines,extra={})=>({id,number:`N-${id}`,kind,status:"posted",occurredAt:`${date}T12:00:00.000Z`,total:lines.reduce((s,l)=>s+l.lineTotal,0),paidTotal:0,dueTotal:0,lines,...extra});
test("report periods and strict paging/group allowlists",()=>{const value=parse("type=sales&from=2026-08-01&to=2026-08-21&page=2&pageSize=100");assert.deepEqual([value.from,value.to,value.page,value.pageSize],["2026-08-01","2026-08-21",2,100]);assert.throws(()=>parse("type=sales&from=2026-08-22&to=2026-08-21"),/بداية الفترة/);assert.throws(()=>parse("type=tax&from=2026-08-01&to=2026-08-21"),/نوع التقرير/);assert.throws(()=>parse("type=profit&from=2026-08-01&to=2026-08-21&groupBy=party"),/groupBy/);});
test("legacy sale adjustments preserve historical profit independently of current product cost",async()=>{await db.collection("products").insertOne({id:"a",lastPurchaseCost:999});await db.collection("documents").insertMany([doc("sale","sale","2026-08-10",[line("s","a",10,100,70)]),doc("ret","return","2026-08-11",[line("r","a",2,100,70)],{parentDocumentId:"sale"})]);const report=await buildReport(db,filters("profit"));assert.equal(report.summary.revenue,800);assert.equal(report.summary.cost,560);assert.equal(report.summary.profit,240);});
test("legacy cost uses latest purchase before sale, never a later purchase",async()=>{await db.collection("documents").insertMany([doc("p1","purchase","2026-08-01",[line("p1l","a",1,60)]),doc("p2","purchase","2026-08-05",[line("p2l","a",1,70)]),doc("s","sale","2026-08-10",[line("sl","a",10,100)]),doc("p3","purchase","2026-08-20",[line("p3l","a",1,500)])]);const report=await buildReport(db,filters("profit"));assert.equal(report.summary.cost,700);assert.equal(report.summary.profit,300);assert.equal((await db.collection("documents").findOne({id:"s"})).lines[0].costAtSale,undefined);});
test("unknown legacy cost is calculated as zero while provenance stays unknown",async()=>{await db.collection("documents").insertOne(doc("s","sale","2026-08-10",[line("sl","a",2,11000)]));const report=await buildReport(db,filters("profit"));assert.equal(report.summary.unknownRevenue,22000);assert.equal(report.summary.cost,0);assert.equal(report.summary.profit,22000);assert.equal(report.rows[0].costKnown,false);assert.equal(report.rows[0].cost,0);assert.equal(report.rows[0].profit,22000);assert.equal(report.rows[0].margin,100);});
test("summary includes known and unknown cost sales without null financial values",async()=>{await db.collection("documents").insertMany([doc("known","sale","2026-08-10",[line("kl","a",1,20000,14500)]),doc("unknown","sale","2026-08-11",[line("ul","b",1,22000)])]);const report=await buildReport(db,filters("sales"));assert.deepEqual([report.summary.netSales,report.summary.cost,report.summary.profit],[42000,14500,27500]);for(const row of report.rows)for(const key of ["cost","profit","margin"])assert.equal(Number.isFinite(row[key]),true,`${key} must be finite`);});
test("product filters retain legacy adjustments without exposing a returns report",async()=>{await db.collection("documents").insertMany([doc("s","sale","2026-08-10",[line("a","a",10,100,70),line("b","b",1,5000,100)]),doc("p","purchase","2026-08-10",[line("pa","a",3,50),line("pb","b",1,900)]),doc("r","return","2026-08-11",[line("ra","a",2,100,70),line("rb","b",1,5000,100)],{parentDocumentId:"s"})]);const sales=await buildReport(db,filters("sales",{productId:"a"})),purchases=await buildReport(db,filters("purchases",{productId:"a"})),profit=await buildReport(db,filters("profit",{productId:"a"}));assert.equal(sales.summary.netSales,800);assert.equal(sales.summary.profit,240);assert.equal(purchases.summary.total,150);assert.equal(profit.summary.revenue,800);assert.equal(profit.rows.some(row=>row.productId==="b"),false);assert.throws(()=>parse("type=returns&from=2026-08-01&to=2026-08-31"),/نوع التقرير/);});
test("product profit invoiceCount is unique per document",async()=>{await db.collection("documents").insertMany([doc("s1","sale","2026-08-10",[line("1","a",1,100,70),line("2","a",2,100,70)]),doc("s2","sale","2026-08-11",[line("3","a",1,100,70)])]);const report=await buildReport(db,filters("profit",{groupBy:"product"}));assert.equal(report.rows[0].invoiceCount,2);});
test("financial transfers are excluded from operating totals",async()=>{await db.collection("financialMovements").insertMany([{id:"1",occurredAt:"2026-08-10T12:00:00Z",type:"sale",direction:"in",amount:100},{id:"2",occurredAt:"2026-08-10T12:00:00Z",type:"transfer-in",direction:"in",amount:500},{id:"3",occurredAt:"2026-08-10T12:00:00Z",type:"transfer-out",direction:"out",amount:500}]);const report=await buildReport(db,filters("financial"));assert.equal(report.summary.incoming,600);assert.equal(report.summary.operatingIncoming,100);assert.equal(report.summary.operatingNet,100);});
test("overview uses typed party balances and every authoritative active payment account",async()=>{await db.collection("paymentAccounts").insertMany([{id:"cash-id",code:"cash",name:"Cash",balance:1000,isActive:true},{id:"a",code:"a",name:"Bank A",balance:500,isActive:true},{id:"b",code:"b",name:"Bank B",balance:300,isActive:true},{id:"off",code:"off",name:"Inactive",balance:900,isActive:false}]);await db.collection("parties").insertMany([{id:"legacy",name:"Legacy",receivable:0,payable:20},{id:"c",name:"C",partyType:"customer",receivable:300,payable:99},{id:"s",name:"S",partyType:"supplier",payable:300,receivable:88}]);const report=await buildReport(db,filters("overview"));assert.equal(report.summary.customerReceivables,201);assert.equal(report.summary.supplierPayables,232);assert.deepEqual([report.summary.customerCount,report.summary.supplierCount],[1,2]);assert.deepEqual(report.bankAccounts.map(a=>[a.name,a.balance]),[["Bank A",500],["Bank B",300],["Cash",1000]]);assert.equal(report.summary.bankBalance,1800);assert.equal(report.summary.bankBalance,report.bankAccounts.reduce((sum,a)=>sum+a.balance,0));});


test("overview current position is netted, complete, finite, and independent of the selected period",async()=>{

  await db.collection("parties").insertMany([{id:"a",name:"A",receivable:100,payable:20},{id:"b",name:"B",receivable:10,payable:50}]);
  await db.collection("warehouses").insertMany([{_id:"wa",name:"Warehouse A"},{_id:"wb",name:"Warehouse B"},{_id:"zero",name:"Zero"},{_id:"old",name:"Old",isArchived:true}]);
  await db.collection("products").insertMany([
    {id:"p1",stocks:{wa:10,wb:2},lastPurchaseCost:20,pieceCost:999},
    {id:"p2",stocks:{wa:5},lastPurchaseCost:30},
    {id:"archived-product",isArchived:true,stocks:{wa:4},lastPurchaseCost:50},
    {id:"legacy-cost",stocks:{old:3},pieceCost:10},
  ]);
  await db.collection("paymentAccounts").insertMany([{id:"cash",name:"Cash",balance:100,isActive:true},{id:"bankily",name:"Bankily",balance:50},{id:"bank",name:"Bank",balance:-20},{id:"zero",name:"Zero",balance:0},{id:"archived",name:"Archived",balance:999,isArchived:true}]);
  await db.collection("financialMovements").insertOne({id:"period",occurredAt:"2026-08-10T12:00:00Z",amount:7,direction:"in"});
  const report=await buildReport(db,filters("overview",{from:"2020-01-01",to:"2020-01-01"}));
  assert.deepEqual([report.summary.currentReceivable,report.summary.currentPayable],[80,40]);
  assert.deepEqual(report.warehouseValues.map(w=>[w.name,w.value,w.archived??false]),[["Old",30,true],["Warehouse A",550,false],["Warehouse B",40,false],["Zero",0,false]]);
  assert.equal(report.summary.currentInventoryValue,620);
  assert.deepEqual(report.bankAccounts.map(a=>[a.name,a.balance]),[["Bank",-20],["Bankily",50],["Cash",100],["Zero",0]]);
  assert.equal(report.summary.currentAccountsBalance,130);
  for(const value of [report.summary.currentReceivable,report.summary.currentPayable,report.summary.currentInventoryValue,report.summary.currentAccountsBalance,...report.bankAccounts.map(a=>a.balance),...report.warehouseValues.map(w=>w.value)])assert.equal(Number.isFinite(value),true);
});

test("overview invoices expose accounting values and preserve business grouping",async()=>{await db.collection("documents").insertMany([doc("s2","sale","2026-08-20",[line("s2l","a",2,5000,3000)],{sequence:2}),doc("p1","purchase","2026-08-01",[line("p1l","a",3,2000)],{sequence:1}),doc("e1","expense","2026-08-02",[],{sequence:1,total:1500,title:"Rent"}),doc("s1","sale","2026-08-15",[line("s1l","a",1,1000,700)],{sequence:1}),doc("p2","purchase","2026-08-03",[line("p2l","a",1,400)],{sequence:2})]);const report=await buildReport(db,filters("overview"));assert.deepEqual(report.invoices.map(x=>`${x.kind}:${x.sequence}`),["sale:1","sale:2","purchase:1","purchase:2","expense:1"]);const sale=report.invoices.find(x=>x.id==="s2"),purchase=report.invoices.find(x=>x.id==="p1"),expense=report.invoices.find(x=>x.id==="e1");assert.deepEqual([sale.invoiceValue,sale.cost,sale.profit],[10000,6000,4000]);assert.deepEqual([purchase.invoiceValue,purchase.cost,purchase.profit],[6000,6000,null]);assert.deepEqual([expense.invoiceValue,expense.cost,expense.profit],[1500,1500,null]);assert.deepEqual([report.summary.salesCost,report.summary.salesProfit],[6700,4300]);});
test("allTime ignores dates, keeps full summary across pages, and normal range remains bounded",async()=>{await db.collection("documents").insertMany([doc("old","sale","2020-01-01",[line("o","a",1,100,70)]),doc("new","sale","2026-08-10",[line("n","a",2,100,70)])]);const all=await buildReport(db,{type:"sales",allTime:true,page:1,pageSize:1}),dated=await buildReport(db,filters("sales",{pageSize:1}));assert.equal(all.meta.totalRows,2);assert.equal(all.rows.length,1);assert.equal(all.summary.netSales,300);assert.equal(dated.meta.totalRows,1);assert.equal(dated.summary.netSales,200);assert.equal(parse("type=sales&allTime=true&page=1&pageSize=100").allTime,true);});

test("current product identity fills blank legacy names across product, profit, stock, and purchase reports",async()=>{await db.collection("products").insertOne({id:"a",name:"الاسم الحالي",sku:"SKU-A"});const blank=line("s","a",1,100,70);blank.description="";await db.collection("documents").insertMany([doc("sale","sale","2026-08-10",[blank]),doc("purchase","purchase","2026-08-10",[{...blank,id:"p",unitPrice:50,lineTotal:50}])]);await db.collection("stockMovements").insertOne({id:"m",documentId:"sale",occurredAt:"2026-08-10T12:00:00Z",productId:"a",productName:"",warehouseName:"Main",type:"sale",balanceBefore:2,quantityDelta:-1,balanceAfter:1,documentNumber:"N-sale"});for(const report of [await buildReport(db,filters("product-sales")),await buildReport(db,filters("profit",{groupBy:"product"})),await buildReport(db,filters("stock")),await buildReport(db,filters("purchases",{productId:"a"}))]){assert.equal(report.rows[0].product,"الاسم الحالي");assert.equal(report.rows[0].sku,"SKU-A");}});

import { reportDateQuery, reportSummaryTone, reportTableModel } from "../app/report-types.ts";

test("report date and all-time requests remain distinct", () => {
  assert.deepEqual(reportDateQuery(false, "2026-08-01", "2026-08-22"), { from: "2026-08-01", to: "2026-08-22" });
  assert.deepEqual(reportDateQuery(true, "2026-08-01", "2026-08-22"), { allTime: "true" });
});

test("report summary tones follow financial meaning rather than numeric sign alone", () => {
  assert.equal(reportSummaryTone("profit", "profit", 20), "positive");
  assert.equal(reportSummaryTone("profit", "profit", -20), "negative");
  assert.equal(reportSummaryTone("debts", "receivable", 20), "positive");
  assert.equal(reportSummaryTone("party-ledger", "payable", 20), "negative");
  assert.equal(reportSummaryTone("financial", "net", 20), "positive");
  assert.equal(reportSummaryTone("financial", "net", -20), "negative");
  assert.equal(reportSummaryTone("purchases", "total", 20), "neutral");
});


test("report table retains known headers before a result exists", () => {
  const columns = [["number", "الفاتورة"], ["total", "الإجمالي"]];
  assert.deepEqual(reportTableModel(columns, null), { columns, rows: [] });
});

test("unpaged report returns every matching row while retaining full summary", async()=>{

  await db.collection("documents").insertMany(Array.from({length:245},(_,i)=>doc(String(i),"sale","2026-08-10",[line(String(i),"a",1,10,4)])));
  const report=await buildReport(db,filters("sales",{unpaged:true,pageSize:1}));
  assert.equal(report.meta.totalRows,245); assert.equal(report.rows.length,245); assert.equal(report.summary.netSales,2450);
  assert.equal(parse("type=sales&from=2026-08-01&to=2026-08-31&unpaged=true").unpaged,true);
});

test("purchase summary exposes total paid and due and expiry loss is non-cash stock valuation",async()=>{

  await db.collection("documents").insertMany([doc("p1","purchase","2026-08-10",[line("l1","a",2,50)],{paidTotal:40,dueTotal:60}),doc("p2","purchase","2026-08-11",[line("l2","a",1,70)],{paidTotal:70,dueTotal:0})]);
  const purchase=await buildReport(db,filters("purchases",{unpaged:true})); assert.deepEqual([purchase.summary.total,purchase.summary.paid,purchase.summary.due],[170,110,60]);
  const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10); await db.collection("products").insertOne({id:"a",name:"A",expiryDate:yesterday,lastPurchaseCost:12,pieceCost:3,stocks:{one:4,two:1}});
  const before=await db.collection("financialMovements").countDocuments(); const stock=await buildReport(db,filters("stock",{unpaged:true}));
  assert.equal(stock.summary.expiredInventoryLoss,60); assert.equal(await db.collection("financialMovements").countDocuments(),before); assert.equal((await db.collection("products").findOne({id:"a"})).stocks.one,4);
});

test("party ledger preserves historical totals for legacy sale adjustments",async()=>{

  await db.collection("parties").insertMany([{id:"c",name:"Customer",partyType:"customer",receivable:0,payable:100},{id:"s",name:"Supplier",partyType:"supplier",receivable:100,payable:0}]);
  await db.collection("documents").insertMany([
    doc("sale","sale","2026-08-10",[line("sl","a",1,1000)],{partyId:"c",dueTotal:1000}),
    doc("return","return","2026-08-11",[line("rl","a",1,200)],{partyId:"c",parentDocumentId:"sale"}),
    doc("customer-cash","payment","2026-08-12",[],{partyId:"c",total:500,partyCashDirection:"receive",partyBalanceDelta:-500}),
    doc("purchase","purchase","2026-08-10",[line("pl","a",1,500)],{partyId:"s",dueTotal:500}),
    doc("supplier-cash","payment","2026-08-12",[],{partyId:"s",total:500,partyCashDirection:"pay",partyBalanceDelta:500}),
  ]);
  const customer=await buildReport(db,filters("party-ledger",{partyId:"c"})),supplier=await buildReport(db,filters("party-ledger",{partyId:"s"}));
  assert.equal(customer.summary.tradeTotal,800); assert.equal(customer.summary.net,-100);
  assert.equal(supplier.summary.tradeTotal,500); assert.equal(supplier.summary.net,100);
});

test("party ledger gives structured deltas authority and retains legacy payment fallback",async()=>{
   await db.collection("parties").insertOne({id:"c",name:"Customer",partyType:"customer",receivable:0,payable:0});
  await db.collection("documents").insertMany([
    doc("receive","payment","2026-08-10",[],{partyId:"c",total:40,title:"new title ignored",partyCashDirection:"receive",partyBalanceDelta:-40}),
    doc("pay","payment","2026-08-11",[],{partyId:"c",total:30,title:"new title ignored",partyCashDirection:"pay",partyBalanceDelta:30}),
    doc("legacy","payment","2026-08-12",[],{partyId:"c",total:20,title:"دفع لنا"}),
  ]);
  const report=await buildReport(db,filters("party-ledger",{partyId:"c"})),byId=new Map(report.rows.map(row=>[row.id,row]));
  assert.deepEqual([byId.get("receive").debit,byId.get("receive").credit],[0,40]);
  assert.deepEqual([byId.get("pay").debit,byId.get("pay").credit],[30,0]);
  assert.deepEqual([byId.get("legacy").debit,byId.get("legacy").credit],[0,20]);
  assert.equal(byId.get("receive").movementType,"استلام من العميل"); assert.equal(byId.get("pay").movementType,"دفع للعميل");
});
test("product movement combines period commerce with current active-warehouse stock",async()=>{await db.collection("warehouses").insertMany([{_id:"w1",name:"Active"},{_id:"old",name:"Archived",isArchived:true}]);await db.collection("products").insertOne({id:"a",name:"A",sku:"A",stocks:{w1:7,old:99}});await db.collection("documents").insertMany([doc("p","purchase","2026-08-02",[line("pl","a",5,60)]),doc("s","sale","2026-08-10",[line("sl","a",3,100,60)]),doc("r","return","2026-08-11",[line("rl","a",1,100,60)],{parentDocumentId:"s"})]);const report=await buildReport(db,filters("product-sales")),row=report.rows[0];assert.deepEqual([row.soldQuantity,row.currentQuantity,row.netSales,row.purchasedQuantity,row.purchases,row.netPurchases,row.averagePrice,row.averagePurchasePrice,row.profit],[2,7,200,5,300,300,100,60,80]);assert.equal("returnedQuantity" in row,false);assert.equal("returns" in row,false);});
test("financial operating summary classifies sales and expenses but not transfers",async()=>{await db.collection("financialMovements").insertMany([{id:"sale",occurredAt:"2026-08-10T12:00:00Z",type:"sale",direction:"in",amount:1000},{id:"expense",occurredAt:"2026-08-10T13:00:00Z",type:"expense",direction:"out",amount:200},{id:"ti",occurredAt:"2026-08-10T14:00:00Z",type:"transfer-in",direction:"in",amount:1000},{id:"to",occurredAt:"2026-08-10T14:00:00Z",type:"transfer-out",direction:"out",amount:1000}]);const report=await buildReport(db,filters("financial"));assert.deepEqual([report.summary.businessIncoming,report.summary.businessOutgoing,report.summary.businessNet,report.summary.balanceNet],[1000,200,800,800]);});
test("expense summary splits only materialized recurring documents",async()=>{await db.collection("documents").insertMany([doc("rec","expense","2026-08-10",[],{total:300,recurringId:"rent"}),doc("once","expense","2026-08-11",[],{total:200})]);const report=await buildReport(db,filters("expenses"));assert.deepEqual([report.summary.total,report.summary.recurringTotal,report.summary.oneOffTotal,report.summary.count],[500,300,200,2]);});
test("party ledger summary reuses row effects for debit and credit totals",async()=>{await db.collection("parties").insertOne({id:"c",name:"Customer",partyType:"customer",receivable:0,payable:0});await db.collection("documents").insertMany([doc("sale","sale","2026-08-10",[],{partyId:"c",total:100,dueTotal:100}),doc("pay","payment","2026-08-11",[],{partyId:"c",total:100,partyCashDirection:"receive"})]);const report=await buildReport(db,filters("party-ledger",{partyId:"c"}));assert.deepEqual([report.summary.debitTotal,report.summary.creditTotal,report.summary.net],[100,100,0]);});
