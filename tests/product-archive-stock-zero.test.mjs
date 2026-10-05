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

test("perfume archive stock-clearance corrections stay visible but cannot be edited or voided",async()=>{
  await insertProduct({stocks:{a:2,b:0},lots:[lot("l1",{a:2,b:0},2)]});
  await command({type:"product.delete",id:"p",zeroStock:true});
  const document=await db.collection("documents").findOne({productArchiveStockClearance:true,warehouseId:"a"});
  assert.ok(document);
  await assert.rejects(command({type:"adjustment.update",documentId:document.id,reason:"rewrite",lines:[{productId:"p",actualQuantity:2}]}),/أرشفة المنتج/);
  await assert.rejects(command({type:"adjustment.void",documentId:document.id}),/أرشفة المنتج/);
  const stored=await db.collection("documents").findOne({id:document.id});
  assert.equal(stored.status,"posted");
  assert.equal((await db.collection("products").findOne({id:"p"})).isArchived,true);
  assert.equal((await db.collection("products").findOne({id:"p"})).stocks.a,0);
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
  assert.match(route,/perfumeCommands[\s\S]*"product\.delete"[\s\S]*"product\.stock-zero"/);
  assert.match(base,/perfumeLots/);
  assert.match(base,/remainingQuantity\s*=\s*0/);
  assert.match(base,/productArchiveStockClearance/);
  assert.match(lifecycle,/productArchiveStockClearance/);
});
