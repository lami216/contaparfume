import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after, before, beforeEach } from "node:test";
import { buildReport, parseReportFilters } from "../lib/reports.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

let harness, db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
beforeEach(async()=>{await harness.reset()});
after(async()=>{await harness.close()});
const f=(type,extra={})=>({type,from:"2026-09-01",to:"2026-09-30",page:1,pageSize:100,...extra});
const line=(id,productId,quantity,unitPrice,costAtSale)=>({id,productId,description:productId,quantity,unitPrice,lineTotal:quantity*unitPrice,...(costAtSale===undefined?{}:{costAtSale})});
const doc=(id,kind,lines)=>({id,number:`N-${id}`,kind,status:"posted",occurredAt:"2026-09-08T12:00:00.000Z",total:lines.reduce((s,l)=>s+l.lineTotal,0),paidTotal:0,dueTotal:0,lines});

test("invoice category picker keeps a chosen category after its list closes",()=>{
  const source=fs.readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(source,/onOpenChange=\{open=>\{setCategoryOpen\(open\);if\(open\)setCategoryId\(""\)\}\}/);
  assert.doesNotMatch(source,/onOpenChange=\{open=>\{setCategoryOpen\(open\);if\(!open\)setCategoryId\(""\)\}\}/);
});

test("categoryId is parsed and constrains real report data",async()=>{
  const parsed=parseReportFilters(new URL("http://localhost/api/reports?type=sales&from=2026-09-01&to=2026-09-30&categoryId=cat-a"));
  assert.equal(parsed.categoryId,"cat-a");
  await db.collection("products").insertMany([
    {id:"a",name:"Alpha",sku:"001",categoryId:"cat-a",stocks:{main:10},lastPurchaseCost:40},
    {id:"b",name:"Beta",sku:"002",categoryId:"cat-b",stocks:{main:10},lastPurchaseCost:30},
    {id:"c",name:"Gamma",sku:"003",categoryId:"cat-a",stocks:{main:10},lastPurchaseCost:55},
  ]);
  await db.collection("documents").insertMany([
    doc("sale","sale",[line("sa","a",2,100,40),line("sb","b",3,200,30)]),
    doc("purchase","purchase",[line("pa","a",4,50),line("pc","c",2,70),line("pb","b",5,60)]),
  ]);
  await db.collection("stockMovements").insertMany([
    {id:"ma",documentId:"sale",occurredAt:"2026-09-08T12:00:00.000Z",productId:"a",productName:"Alpha",warehouseId:"main",warehouseName:"Main",type:"sale",balanceBefore:10,quantityDelta:-2,balanceAfter:8,documentNumber:"N-sale"},
    {id:"mb",documentId:"sale",occurredAt:"2026-09-08T12:00:00.000Z",productId:"b",productName:"Beta",warehouseId:"main",warehouseName:"Main",type:"sale",balanceBefore:10,quantityDelta:-3,balanceAfter:7,documentNumber:"N-sale"},
  ]);

  const sales=await buildReport(db,f("sales",{categoryId:"cat-a"}));
  const purchases=await buildReport(db,f("purchases",{categoryId:"cat-a"}));
  const productSales=await buildReport(db,f("product-sales",{categoryId:"cat-a"}));
  const profit=await buildReport(db,f("profit",{categoryId:"cat-a",groupBy:"product"}));
  const stock=await buildReport(db,f("stock",{categoryId:"cat-a"}));

  assert.equal(sales.summary.netSales,200);
  assert.equal(purchases.summary.total,340);
  assert.deepEqual(purchases.rows.map(row=>row.product),["Alpha","Gamma"]);
  assert.deepEqual(purchases.rows.map(row=>row.quantity),[4,2]);
  assert.deepEqual(productSales.rows.map(row=>row.productId),["a","c"]);
  assert.equal(profit.summary.revenue,200);
  assert.deepEqual(profit.rows.map(row=>row.productId),["a"]);
  assert.deepEqual(stock.rows.map(row=>row.product),["Alpha"]);
});

test("combobox selected, hover and keyboard-highlight states share the blue rule",()=>{
  const css=fs.readFileSync(new URL("../app/globals.css",import.meta.url),"utf8");
  assert.match(css,/Category picker option states use one consistent blue interaction color/);
  assert.match(css,/\.combobox-results button\.selected,[\s\S]*button:hover,[\s\S]*button\.highlighted,[\s\S]*background: #1967d2/);
});
