import assert from "node:assert/strict";
import test,{after,before,beforeEach} from "node:test";
import {readFile} from "node:fs/promises";
import {sqliteHarness} from "./sqlite-harness.mjs";
import {execute} from "../app/api/command/route.ts";

let harness,db;
before(async()=>{harness=await sqliteHarness();db=harness.db});
after(async()=>{await harness.close()});
beforeEach(async()=>{
  await harness.reset();
  await db.collection("warehouses").insertMany([
    {_id:"a",name:"A",isSalesDefault:true},
    {_id:"b",name:"B",isSalesDefault:false},
  ]);
});
const command=body=>db.transaction(session=>execute(db,session,body));
const lot=(id,stocks,remainingQuantity)=>({
  id,sourceProductId:"source",sourceProductName:"Source perfume",originalQuantity:10,remainingQuantity,
  liquidUnitCost:12,bottleCost:0,landedUnitCost:12,decantSizeMl:null,stocks,
  createdAt:"2026-09-01T00:00:00.000Z",conversionDocumentId:`split-${id}`,
});
const insertProduct=async({id="p",stocks={a:5,b:1},lots=[lot("l1",{a:3,b:4},7)],isArchived=false}={})=>{
  await db.collection("products").insertOne({
    id,name:"Decant product",sku:`SKU-${id}`,barcode:`BAR-${id}`,perfumeForm:"decant",
    pieceCost:12,lastPurchaseCost:12,lastPurchaseCostSource:"adjustment",piecePrice:25,wholesalePrice:22,
    stocks,perfumeLots:lots,isArchived,archivedAt:isArchived?new Date():null,createdAt:new Date(),
  });
};

test("perfume archive zero clears both visible stock and divergent lot stock in the same transaction",async()=>{
  await insertProduct();
  await assert.rejects(command({type:"product.delete",id:"p"}),/تصفير المخزون/);
  await command({type:"product.delete",id:"p",zeroStock:true});
  const product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,true);
  assert.deepEqual(product.stocks,{a:0,b:0});
  assert.deepEqual(product.perfumeLots[0].stocks,{a:0,b:0});
  assert.equal(product.perfumeLots[0].remainingQuantity,0);
  const docs=await db.collection("documents").find({productArchiveStockClearance:true}).sort({warehouseId:1}).toArray();
  assert.equal(docs.length,2);
  assert.deepEqual(docs.map(d=>[d.warehouseId,d.lines[0].balanceBefore,d.lines[0].perfumeLotStockBefore,d.lines[0].perfumeLotStockAfter]),[
    ["a",5,3,0],["b",1,4,0],
  ]);
  const movements=await db.collection("stockMovements").find({productId:"p"}).sort({warehouseId:1}).toArray();
  assert.deepEqual(movements.map(m=>[m.warehouseId,m.quantityDelta,m.balanceAfter]),[["a",-5,0],["b",-1,0]]);
});

test("legacy archived perfume product can clear lot-only stock and stays archived",async()=>{
  await insertProduct({stocks:{a:0,b:0},lots:[lot("legacy",{a:2,b:0},2)],isArchived:true});
  await command({type:"product.stock-zero",id:"p"});
  const product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,true);
  assert.deepEqual(product.stocks,{a:0,b:0});
  assert.deepEqual(product.perfumeLots[0].stocks,{a:0,b:0});
  assert.equal(product.perfumeLots[0].remainingQuantity,0);
  const docs=await db.collection("documents").find({productArchiveStockClearance:true}).toArray();
  assert.equal(docs.length,1);
  assert.equal(docs[0].warehouseId,"a");
  assert.deepEqual([docs[0].lines[0].quantity,docs[0].lines[0].perfumeLotStockBefore],[0,2]);
});

test("voiding one perfume archive clearance restores all linked warehouses and exact lots",async()=>{
  const lots=[lot("l1",{a:2,b:1},3),lot("l2",{a:1,b:2},3)];
  await insertProduct({stocks:{a:3,b:3},lots});
  await command({type:"product.delete",id:"p",zeroStock:true});
  const docs=await db.collection("documents").find({productArchiveStockClearance:true}).sort({warehouseId:1}).toArray();
  assert.equal(docs.length,2);
  assert.ok(docs[0].productArchiveStockClearanceGroupId);
  assert.equal(docs[0].productArchiveStockClearanceGroupId,docs[1].productArchiveStockClearanceGroupId);
  assert.deepEqual(docs[0].productArchivePerfumeLotsBefore,lots);
  await assert.rejects(command({type:"adjustment.update",documentId:docs[0].id,reason:"rewrite",lines:[{productId:"p",actualQuantity:2}]}),/أرشفة المنتج/);
  await command({type:"adjustment.void",documentId:docs[0].id});
  const product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,false);
  assert.deepEqual(product.stocks,{a:3,b:3});
  assert.deepEqual(product.perfumeLots,lots);
  const reversed=await db.collection("documents").find({productArchiveStockClearance:true}).sort({warehouseId:1}).toArray();
  assert.deepEqual(reversed.map(document=>[document.warehouseId,document.status,document.productArchiveStockClearanceRestored]),[["a","voided",true],["b","voided",true]]);
});

test("product restore restores linked perfume stock instead of reviving an empty product",async()=>{
  const lots=[lot("l1",{a:2,b:1},3),lot("l2",{a:0,b:2},2)];
  await insertProduct({stocks:{a:2,b:3},lots});
  await command({type:"product.delete",id:"p",zeroStock:true});
  await command({type:"product.restore",id:"p"});
  const product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,false);
  assert.deepEqual(product.stocks,{a:2,b:3});
  assert.deepEqual(product.perfumeLots,lots);
  assert.equal(await db.collection("documents").countDocuments({productArchiveStockClearance:true,status:"posted"}),0);
});

test("legacy one-lot perfume clearance can be reconstructed but legacy multi-lot clearance is blocked",async()=>{
  await insertProduct({stocks:{a:0,b:0},lots:[lot("legacy",{a:0,b:0},0)],isArchived:true});
  await db.collection("documents").insertMany([
    {id:"legacy-a",number:"ADJ-LA",kind:"adjustment",status:"posted",occurredAt:"2026-09-29T10:00:00.000Z",revision:0,productArchiveStockClearance:true,warehouseId:"a",warehouseName:"A",title:"تصفير المخزون المرتبط بأرشفة المنتج",lines:[{id:"la",productId:"p",quantity:-2,balanceBefore:2,balanceAfter:0,perfumeLotStockBefore:2,perfumeLotStockAfter:0}]},
    {id:"legacy-b",number:"ADJ-LB",kind:"adjustment",status:"posted",occurredAt:"2026-09-29T10:00:01.000Z",revision:0,productArchiveStockClearance:true,warehouseId:"b",warehouseName:"B",title:"تصفير المخزون المرتبط بأرشفة المنتج",lines:[{id:"lb",productId:"p",quantity:-1,balanceBefore:1,balanceAfter:0,perfumeLotStockBefore:1,perfumeLotStockAfter:0}]},
  ]);
  await command({type:"adjustment.void",documentId:"legacy-a"});
  let product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,false);
  assert.deepEqual(product.stocks,{a:2,b:1});
  assert.deepEqual(product.perfumeLots[0].stocks,{a:2,b:1});
  assert.equal(product.perfumeLots[0].remainingQuantity,3);

  await harness.reset();
  await db.collection("warehouses").insertMany([{_id:"a",name:"A",isSalesDefault:true},{_id:"b",name:"B",isSalesDefault:false}]);
  await insertProduct({stocks:{a:0,b:0},lots:[lot("l1",{a:0,b:0},0),lot("l2",{a:0,b:0},0)],isArchived:true});
  await db.collection("documents").insertMany([
    {id:"legacy2-a",number:"ADJ-2A",kind:"adjustment",status:"posted",occurredAt:"2026-09-29T11:00:00.000Z",revision:0,productArchiveStockClearance:true,warehouseId:"a",warehouseName:"A",title:"تصفير المخزون المرتبط بأرشفة المنتج",lines:[{id:"l2a",productId:"p",quantity:-2,balanceBefore:2,balanceAfter:0,perfumeLotStockBefore:2,perfumeLotStockAfter:0}]},
    {id:"legacy2-b",number:"ADJ-2B",kind:"adjustment",status:"posted",occurredAt:"2026-09-29T11:00:01.000Z",revision:0,productArchiveStockClearance:true,warehouseId:"b",warehouseName:"B",title:"تصفير المخزون المرتبط بأرشفة المنتج",lines:[{id:"l2b",productId:"p",quantity:-1,balanceBefore:1,balanceAfter:0,perfumeLotStockBefore:1,perfumeLotStockAfter:0}]},
  ]);
  await assert.rejects(command({type:"adjustment.void",documentId:"legacy2-a"}),/توزيع الدفعات التاريخي غير محفوظ/);
  product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,true);
  assert.deepEqual(product.stocks,{a:0,b:0});
});

test("archive clearance restoration is blocked if visible stock or perfume lots changed after zeroing",async()=>{
  await insertProduct({stocks:{a:2,b:0},lots:[lot("l1",{a:2,b:0},2)]});
  await command({type:"product.delete",id:"p",zeroStock:true});
  const document=await db.collection("documents").findOne({productArchiveStockClearance:true});
  await db.collection("products").updateOne({id:"p"},{$set:{"stocks.a":1}});
  await assert.rejects(command({type:"adjustment.void",documentId:document.id}),/مخزون أحد المخازن تغير/);
  await db.collection("products").updateOne({id:"p"},{$set:{"stocks.a":0,"perfumeLots.0.stocks.a":1,"perfumeLots.0.remainingQuantity":1}});
  await assert.rejects(command({type:"adjustment.void",documentId:document.id}),/دفعات التقسيمات تغيرت/);
});

test("perfume clearance rollback restores visible stock and perfumeLots together on invalid warehouse",async()=>{
  await insertProduct({stocks:{a:4,missing:1},lots:[lot("l1",{a:2,missing:3},5)]});
  await assert.rejects(command({type:"product.delete",id:"p",zeroStock:true}),/تعذر تصفير المخزون/);
  const product=await db.collection("products").findOne({id:"p"});
  assert.equal(product.isArchived,false);
  assert.deepEqual(product.stocks,{a:4,missing:1});
  assert.deepEqual(product.perfumeLots[0].stocks,{a:2,missing:3});
  assert.equal(product.perfumeLots[0].remainingQuantity,5);
  assert.equal(await db.collection("documents").countDocuments({productArchiveStockClearance:true}),0);
});

test("archived perfume zero action is present when stock exists in either product stocks or perfume lots",async()=>{
  const app=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(app,/productArchiveStockQuantity/);
  assert.match(app,/perfumeLots/);
  assert.match(app,/type:"product\.stock-zero",id:product\.id/);
  assert.match(app,/product\.isArchived[\s\S]{0,700}تصفير المخزون/);
});

test("perfume command routing keeps product stock zero under products.delete permission and its own perfume-aware handler",async()=>{
  const [route,base,lifecycle]=await Promise.all([
    readFile(new URL("../app/api/command/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/command/base-route.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/transaction-lifecycle.ts",import.meta.url),"utf8"),
  ]);
  assert.match(route,/"product\.stock-zero"\s*:\s*"products\.delete"/);
  assert.match(route,/perfumeCommands[\s\S]*"product\.delete"[\s\S]*"product\.stock-zero"[\s\S]*"product\.restore"/);
  assert.match(base,/perfumeLots/);
  assert.match(base,/remainingQuantity\s*=\s*0/);
  assert.match(base,/productArchiveStockClearance/);
  assert.match(lifecycle,/restoreProductArchiveStockClearance/);
  assert.match(lifecycle,/productArchivePerfumeLotsBefore/);
  assert.match(lifecycle,/reconstructLegacySinglePerfumeLot/);
});
