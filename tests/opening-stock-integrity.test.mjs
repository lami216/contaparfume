import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";
import { deriveOpeningStockState, planOpeningStockCorrection } from "../lib/opening-stock.ts";
import { inventoryUnitCost } from "../app/domain.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("warehouses").insertMany([
    { _id: "wh-a", name: "A", isSalesDefault: true },
    { _id: "wh-b", name: "B", isSalesDefault: false },
  ]);
  await db.collection("parties").insertMany([
    { id: "customer", name: "Customer", phone: "", partyType: "customer", receivable: 0, payable: 0, net: 0 },
    { id: "supplier", name: "Supplier", phone: "", partyType: "supplier", receivable: 0, payable: 0, net: 0 },
  ]);
  await db.collection("paymentAccounts").insertOne({ id: "cash", code: "cash", name: "Cash", isActive: true, balance: 100000, allowNegativeBalance: true });
});
const command = body => db.transaction(session => execute(db, session, body));
const createOpened = (quantity = 10, cost = 50, warehouse = "wh-a") => command({
  type: "product.create", name: "Opened", pieceCost: cost, piecePrice: 100,
  openingStock: quantity, openingWarehouseId: warehouse,
});
const updateOpening = (id, quantity, cost, warehouse, relocateOpeningStock = false) => command({
  type: "product.update", id, name: "Opened", pieceCost: 999, piecePrice: 100,
  replaceOpeningStock: true, relocateOpeningStock, openingStock: quantity, openingCost: cost, openingWarehouseId: warehouse,
});

test("opening correction replaces the original balance while preserving consumed sales", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const saleId = await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 3, piecePrice: 100 }] });
  const originalSale = await db.collection("documents").findOne({ id: saleId });

  await updateOpening(productId, 8, 60, "wh-a");

  const product = await db.collection("products").findOne({ id: productId });
  assert.equal(product.stocks["wh-a"], 5);
  assert.deepEqual([product.openingStock, product.openingCost, product.lastPurchaseCost, product.lastPurchaseCostSource], [8, 60, 60, "opening"]);
  const sale = await db.collection("documents").findOne({ id: saleId });
  assert.deepEqual([sale.id, sale.status, sale.lines[0].quantity, sale.lines[0].costAtSale], [originalSale.id, "posted", 3, 50]);
  const correction = await db.collection("documents").findOne({ openingCorrection: true });
  assert.deepEqual([correction.openingStockBefore, correction.openingStockAfter, correction.openingCostBefore, correction.openingCostAfter], [10, 8, 50, 60]);
  assert.deepEqual((await db.collection("stockMovements").find({ documentId: correction.id }).toArray()).map(m => [m.warehouseId, m.type, m.quantityDelta]), [["wh-a", "opening-correction", -2]]);
});

test("opening balance cannot be lowered below quantity already consumed", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 3, piecePrice: 100 }] });
  const before = await db.collection("products").findOne({ id: productId });
  const counts = [await db.collection("documents").countDocuments(), await db.collection("stockMovements").countDocuments()];
  await assert.rejects(updateOpening(productId, 2, 50, "wh-a"), /لا يمكن خفض رصيد البداية عن 3/);
  const after = await db.collection("products").findOne({ id: productId });
  assert.deepEqual(after.stocks, before.stocks);
  assert.deepEqual([await db.collection("documents").countDocuments(), await db.collection("stockMovements").countDocuments()], counts);
});

test("changing opening warehouse moves only unsold opening-origin stock", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const saleId = await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 3, piecePrice: 100 }] });
  await updateOpening(productId, 8, 50, "wh-b", true);
  const product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual(product.stocks, { "wh-a": 0, "wh-b": 5 });
  assert.equal((await db.collection("documents").findOne({ id: saleId })).warehouseId, "wh-a");
  const correction = await db.collection("documents").findOne({ openingCorrection: true });
  assert.deepEqual((await db.collection("stockMovements").find({ documentId: correction.id }).sort({ warehouseId: 1 }).toArray()).map(m => [m.warehouseId, m.quantityDelta]), [["wh-a", -7], ["wh-b", 5]]);
});

test("opening provenance follows transfers and later sales before correction", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const transferId = await command({ type: "transfer.post", fromWarehouseId: "wh-a", toWarehouseId: "wh-b", lines: [{ productId, quantity: 5 }] });
  const saleId = await command({ type: "sale.post", warehouseId: "wh-b", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 2, piecePrice: 100 }] });
  const before = await db.collection("products").findOne({ id: productId });
  const state = await deriveOpeningStockState(db, undefined, before);
  assert.deepEqual([state.total, state.consumed, state.remaining, state.allocations["wh-a"], state.allocations["wh-b"]], [10, 2, 8, 5, 3]);

  await updateOpening(productId, 6, 55, "wh-b", true);
  const product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual(product.stocks, { "wh-a": 0, "wh-b": 4 });
  assert.equal((await db.collection("documents").findOne({ id: transferId })).status, "posted");
  assert.deepEqual([(await db.collection("documents").findOne({ id: saleId })).warehouseId, (await db.collection("documents").findOne({ id: saleId })).lines[0].quantity], ["wh-b", 2]);
});

test("real purchase remains cost authority; voiding it falls back to edited opening cost", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const purchaseId = await command({ type: "purchase.post", warehouseId: "wh-a", partyId: "supplier", paymentMethod: "note", lines: [{ productId, quantity: 2, unitPrice: 80 }] });
  await updateOpening(productId, 10, 60, "wh-a");
  let product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual([product.lastPurchaseCost, product.lastPurchaseCostSource, product.openingCost], [80, "purchase", 60]);
  await command({ type: "purchase.void", documentId: purchaseId });
  product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual([product.lastPurchaseCost, product.lastPurchaseCostSource, product.openingCost], [60, "opening", 60]);
});

test("manual product-card purchase price never overrides accounting cost after a real purchase", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  await command({ type: "purchase.post", warehouseId: "wh-a", partyId: "supplier", paymentMethod: "note", lines: [{ productId, quantity: 2, unitPrice: 80 }] });
  await command({ type: "product.update", id: productId, name: "Opened", pieceCost: 999, piecePrice: 100 });
  const product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual([product.pieceCost, product.lastPurchaseCost, product.lastPurchaseCostSource], [999, 80, "purchase"]);
});

test("future sales snapshot the current fallback cost but historical sales stay immutable", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const firstSaleId = await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 1, piecePrice: 100 }] });
  await updateOpening(productId, 10, 60, "wh-a");
  const secondSaleId = await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 1, piecePrice: 100 }] });
  const first = await db.collection("documents").findOne({ id: firstSaleId }), second = await db.collection("documents").findOne({ id: secondSaleId });
  assert.deepEqual([first.lines[0].costAtSale, first.lines[0].grossProfit], [50, 50]);
  assert.deepEqual([second.lines[0].costAtSale, second.lines[0].grossProfit], [60, 40]);
});

test("legacy opening cost is valuation fallback but is not editable native opening provenance", async () => {
  await db.collection("products").insertOne({ id: "legacy", name: "Legacy", sku: "L", barcode: "", pieceCost: 999, legacyOpeningCost: 42, lastPurchaseCost: null, stocks: { "wh-a": 7 } });
  await db.collection("stockMovements").insertOne({ id: "lm", productId: "legacy", productName: "Legacy", warehouseId: "wh-a", warehouseName: "A", documentId: "legacy-opening", documentNumber: "LEG-OPEN", type: "legacy-opening", quantityDelta: 7, balanceBefore: 0, balanceAfter: 7, occurredAt: "2025-01-01T00:00:00.000Z" });
  const product = await db.collection("products").findOne({ id: "legacy" });
  const state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.total, state.remaining, state.consumed], [0, 0, 0]);
  assert.equal(inventoryUnitCost(product), 42);
});

test("pure opening correction plan is deterministic and never creates NaN", () => {
  const state = { total: 10, remaining: 7, consumed: 3, allocations: { a: 4, b: 3 }, warehouseId: "a", cost: 50, hasNativeOpening: true, hasStockHistory: true, legacySnapshot: false };
  assert.deepEqual(planOpeningStockCorrection(state, 8, "b"), { desiredRemaining: 5, desiredAllocations: { a: 4, b: 1 }, deltas: [{ warehouseId: "b", delta: -2 }] });
  assert.deepEqual(planOpeningStockCorrection(state, 8, "b", true), { desiredRemaining: 5, desiredAllocations: { b: 5 }, deltas: [{ warehouseId: "a", delta: -4 }, { warehouseId: "b", delta: 2 }] });
  assert.throws(() => planOpeningStockCorrection(state, 2, "b"), /لا يمكن خفض/);
});


test("quantity-only opening edit preserves transferred allocation instead of silently relocating it", async () => {
  const productId=await createOpened(10,50,"wh-a");
  await command({type:"transfer.post",fromWarehouseId:"wh-a",toWarehouseId:"wh-b",lines:[{productId,quantity:5}]});
  await command({type:"sale.post",warehouseId:"wh-b",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:2,piecePrice:100}]});
  await updateOpening(productId,6,50,"wh-a",false);
  const product=await db.collection("products").findOne({id:productId});
  assert.deepEqual(product.stocks,{"wh-a":1,"wh-b":3});
});

test("voiding a sale restores its consumed opening provenance", async () => {
  const productId=await createOpened(10,50,"wh-a");
  const saleId=await command({type:"sale.post",warehouseId:"wh-a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:3,piecePrice:100}]});
  let product=await db.collection("products").findOne({id:productId});
  assert.equal((await deriveOpeningStockState(db,undefined,product)).consumed,3);
  await command({type:"sale.void",documentId:saleId});
  product=await db.collection("products").findOne({id:productId});
  const state=await deriveOpeningStockState(db,undefined,product);
  assert.deepEqual([state.consumed,state.remaining,product.stocks["wh-a"]],[0,10,10]);
});

test("multiple purchases fall back latest to previous to opening when voided", async () => {
  const productId=await createOpened(10,50,"wh-a");
  const first=await command({type:"purchase.post",warehouseId:"wh-a",partyId:"supplier",paymentMethod:"note",lines:[{productId,quantity:2,unitPrice:70}]});
  const second=await command({type:"purchase.post",warehouseId:"wh-a",partyId:"supplier",paymentMethod:"note",lines:[{productId,quantity:2,unitPrice:90}]});
  let product=await db.collection("products").findOne({id:productId});assert.equal(product.lastPurchaseCost,90);
  await command({type:"purchase.void",documentId:second});product=await db.collection("products").findOne({id:productId});assert.equal(product.lastPurchaseCost,70);
  await command({type:"purchase.void",documentId:first});product=await db.collection("products").findOne({id:productId});assert.deepEqual([product.lastPurchaseCost,product.lastPurchaseCostSource],[50,"opening"]);
});

test("opening can be established later only while product has no stock history", async () => {
  const productId=await command({type:"product.create",name:"Empty",pieceCost:40,piecePrice:100,openingStock:0});
  await command({type:"product.update",id:productId,name:"Empty",pieceCost:40,piecePrice:100,replaceOpeningStock:true,openingStock:4,openingCost:40,openingWarehouseId:"wh-a"});
  let product=await db.collection("products").findOne({id:productId});assert.equal(product.stocks["wh-a"],4);
  const legacyId="legacy-history";await db.collection("products").insertOne({id:legacyId,name:"Legacy history",sku:"L2",barcode:"",pieceCost:20,legacyOpeningCost:20,stocks:{"wh-a":2}});
  await db.collection("stockMovements").insertOne({id:"legacy-h",productId:legacyId,productName:"Legacy history",warehouseId:"wh-a",warehouseName:"A",documentId:"legacy-opening",documentNumber:"LEG-OPEN",type:"legacy-opening",quantityDelta:2,balanceBefore:0,balanceAfter:2,occurredAt:"2025-01-01T00:00:00.000Z"});
  await assert.rejects(command({type:"product.update",id:legacyId,name:"Legacy history",pieceCost:20,piecePrice:100,replaceOpeningStock:true,openingStock:2,openingCost:20,openingWarehouseId:"wh-a"}),/لا يمكن إنشاء رصيد بداية رجعي/);
});

test("cost-only opening correction changes future cost without stock movement", async () => {
  const productId=await createOpened(10,50,"wh-a"),before=await db.collection("stockMovements").countDocuments();
  await updateOpening(productId,10,65,"wh-a",false);
  assert.equal(await db.collection("stockMovements").countDocuments(),before);
  const correction=await db.collection("documents").findOne({openingCorrection:true});assert.equal(correction.lines[0].quantity,0);
  const saleId=await command({type:"sale.post",warehouseId:"wh-a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:1,piecePrice:100}]});
  assert.equal((await db.collection("documents").findOne({id:saleId})).lines[0].costAtSale,65);
});


test("latest opening correction can be edited with net audit movements", async () => {
  const productId=await createOpened(10,50,"wh-a");
  await updateOpening(productId,8,60,"wh-a");
  const correction=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  await command({type:"opening-stock-correction.update",documentId:correction.id,newOpeningStock:9,openingCost:65,openingWarehouseId:"wh-a",relocateOpeningStock:false});
  const product=await db.collection("products").findOne({id:productId});
  const revised=await db.collection("documents").findOne({id:correction.id});
  const movements=await db.collection("stockMovements").find({documentId:correction.id}).toArray();
  assert.deepEqual([product.openingStock,product.openingCost,product.stocks["wh-a"]],[9,65,9]);
  assert.deepEqual([revised.openingStockBefore,revised.openingStockAfter,revised.openingCostBefore,revised.openingCostAfter,revised.revision],[10,9,50,65,1]);
  assert.deepEqual(movements.map(row=>[row.type,row.quantityDelta]),[["opening-correction",-2],["opening-correction-edit",1]]);
  const state=await deriveOpeningStockState(db,undefined,product);
  assert.deepEqual([state.total,state.remaining,state.consumed,state.cost],[9,9,0,65]);
});

test("deleting latest opening correction reverses only that correction and keeps an audit trail", async () => {
  const productId=await createOpened(10,50,"wh-a");
  await updateOpening(productId,8,60,"wh-a");
  const correction=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  await command({type:"opening-stock-correction.void",documentId:correction.id});
  const product=await db.collection("products").findOne({id:productId});
  const voided=await db.collection("documents").findOne({id:correction.id});
  const movements=await db.collection("stockMovements").find({documentId:correction.id}).toArray();
  assert.deepEqual([product.openingStock,product.openingCost,product.stocks["wh-a"]],[10,50,10]);
  assert.equal(voided.status,"voided");
  assert.deepEqual(movements.map(row=>[row.type,row.quantityDelta]),[["opening-correction",-2],["opening-correction-void",2]]);
  const state=await deriveOpeningStockState(db,undefined,product);
  assert.deepEqual([state.total,state.remaining,state.consumed,state.cost],[10,10,0,50]);
});

test("only the latest active opening correction can be edited or deleted", async () => {
  const productId=await createOpened(10,50,"wh-a");
  await updateOpening(productId,9,55,"wh-a");
  const first=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  await updateOpening(productId,8,60,"wh-a");
  await assert.rejects(command({type:"opening-stock-correction.update",documentId:first.id,newOpeningStock:7,openingCost:60,openingWarehouseId:"wh-a"}),/آخر تصحيح رصيد بداية/);
  await assert.rejects(command({type:"opening-stock-correction.void",documentId:first.id}),/آخر تصحيح رصيد بداية/);
});

test("deleting a relocated opening correction is blocked after its stock was moved away", async () => {
  const productId=await createOpened(10,50,"wh-a");
  await updateOpening(productId,10,55,"wh-b",true);
  const correction=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  await command({type:"transfer.post",fromWarehouseId:"wh-b",toWarehouseId:"wh-a",lines:[{productId,quantity:2}]});
  await assert.rejects(command({type:"opening-stock-correction.void",documentId:correction.id}),/جزءًا من المخزون الناتج عنه تم التصرف فيه/);
  const product=await db.collection("products").findOne({id:productId});
  const retained=await db.collection("documents").findOne({id:correction.id});
  assert.deepEqual(product.stocks,{"wh-a":2,"wh-b":8});
  assert.equal(retained.status,"posted");
});


test("blocked opening correction delete exposes related source operations and succeeds after the sale is voided", async () => {
  const productId=await createOpened(2,50,"wh-a");
  await updateOpening(productId,10,55,"wh-a");
  const correction=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  const saleId=await command({type:"sale.post",warehouseId:"wh-a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:5,piecePrice:100}]});

  let blocked;
  try { await command({type:"opening-stock-correction.void",documentId:correction.id}); }
  catch (error) { blocked=error; }
  assert.ok(blocked);
  assert.match(blocked.message,/جزءًا من المخزون الناتج عنه تم التصرف فيه/);
  assert.equal(blocked.details?.code,"OPENING_CORRECTION_BLOCKED");
  assert.deepEqual(blocked.details?.deficits,[{warehouseId:"wh-a",required:8,available:5,missing:3}]);
  assert.equal(blocked.details?.blockers?.length,1);
  assert.deepEqual(
    [blocked.details.blockers[0].documentId,blocked.details.blockers[0].kind,blocked.details.blockers[0].status],
    [saleId,"sale","posted"],
  );
  assert.deepEqual(blocked.details.blockers[0].warehouses.map(row=>[row.warehouseId,row.quantityDelta]),[["wh-a",-5]]);

  await command({type:"sale.void",documentId:saleId});
  await command({type:"opening-stock-correction.void",documentId:correction.id});
  const product=await db.collection("products").findOne({id:productId});
  const voidedCorrection=await db.collection("documents").findOne({id:correction.id});
  const voidedSale=await db.collection("documents").findOne({id:saleId});
  assert.deepEqual([product.openingStock,product.openingCost,product.stocks["wh-a"]],[2,50,2]);
  assert.equal(voidedCorrection.status,"voided");
  assert.equal(voidedSale.status,"voided");
});


test("later purchases do not hide opening stock that was already consumed from the correction", async () => {
  const productId=await createOpened(2,50,"wh-a");
  await updateOpening(productId,10,55,"wh-a");
  const correction=await db.collection("documents").findOne({openingCorrection:true,status:"posted"});
  const saleId=await command({type:"sale.post",warehouseId:"wh-a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:5,piecePrice:100}]});
  await command({type:"purchase.post",warehouseId:"wh-a",partyId:"supplier",paymentMethod:"note",lines:[{productId,quantity:10,unitPrice:70}]});
  const stocked=await db.collection("products").findOne({id:productId});
  assert.equal(stocked.stocks["wh-a"],15);

  let blocked;
  try { await command({type:"opening-stock-correction.void",documentId:correction.id}); }
  catch (error) { blocked=error; }
  assert.equal(blocked?.details?.code,"OPENING_CORRECTION_BLOCKED");
  assert.equal(blocked?.details?.consumedOpening,5);
  assert.equal(blocked?.details?.restoredOpening,2);
  assert.equal(blocked?.details?.blockers?.some(row=>row.documentId===saleId),true);
});


test("legacy additive opening correction without audit fields can be deleted and is canonicalized", async () => {
  const productId=await createOpened(10,50,"wh-a");
  const legacyId="legacy-opening-add";
  const occurredAt="2026-01-02T00:00:00.000Z";
  await db.collection("documents").insertOne({
    id:legacyId,number:"OPEN-LEGACY-ADD",kind:"adjustment",status:"posted",occurredAt,
    partyId:null,partyName:null,warehouseId:"wh-a",warehouseName:"A",destinationWarehouseId:null,destinationWarehouseName:null,
    parentDocumentId:null,paymentMethod:null,title:"إضافة رصيد افتتاحي",total:0,dueTotal:0,paidTotal:0,cashAmount:0,
    lines:[{id:"legacy-line",productId,description:"Opened",quantity:2,unitPrice:50,lineTotal:0}],
  });
  await db.collection("stockMovements").insertOne({
    id:"legacy-opening-movement",documentId:legacyId,documentNumber:"OPEN-LEGACY-ADD",warehouseId:"wh-a",warehouseName:"A",
    productId,productName:"Opened",type:"opening",quantityDelta:2,balanceBefore:10,balanceAfter:12,occurredAt,
  });
  await db.collection("products").updateOne({id:productId},{$set:{openingStock:12,openingCost:50,openingWarehouseId:"wh-a","stocks.wh-a":12}});
  const saleId=await command({type:"sale.post",warehouseId:"wh-a",partyId:"customer",paymentMethod:"note",lines:[{productId,quantity:10,piecePrice:100}]});
  assert.equal((await db.collection("products").findOne({id:productId})).stocks["wh-a"],2);

  await command({type:"opening-stock-correction.void",documentId:legacyId});

  const product=await db.collection("products").findOne({id:productId});
  const legacy=await db.collection("documents").findOne({id:legacyId});
  const sale=await db.collection("documents").findOne({id:saleId});
  const movements=await db.collection("stockMovements").find({documentId:legacyId}).toArray();
  assert.deepEqual([product.openingStock,product.openingCost,product.stocks["wh-a"]],[10,50,0]);
  assert.deepEqual([legacy.openingCorrection,legacy.title,legacy.openingStockBefore,legacy.openingStockAfter,legacy.status],[true,"تصحيح رصيد البداية",10,12,"voided"]);
  assert.deepEqual(movements.map(row=>[row.type,row.quantityDelta]),[["opening",2],["opening-correction-void",-2]]);
  assert.equal(sale.status,"posted");
});

test("legacy additive opening correction becomes fully editable and gains missing audit fields", async () => {
  const productId=await createOpened(10,50,"wh-a");
  const legacyId="legacy-opening-edit";
  const occurredAt="2026-01-02T00:00:00.000Z";
  await db.collection("documents").insertOne({
    id:legacyId,number:"OPEN-LEGACY-EDIT",kind:"adjustment",status:"posted",occurredAt,
    partyId:null,partyName:null,warehouseId:"wh-a",warehouseName:"A",destinationWarehouseId:null,destinationWarehouseName:null,
    parentDocumentId:null,paymentMethod:null,title:"إضافة رصيد افتتاحي",total:0,dueTotal:0,paidTotal:0,cashAmount:0,
    lines:[{id:"legacy-edit-line",productId,description:"Opened",quantity:2,unitPrice:50,lineTotal:0}],
  });
  await db.collection("stockMovements").insertOne({
    id:"legacy-opening-edit-movement",documentId:legacyId,documentNumber:"OPEN-LEGACY-EDIT",warehouseId:"wh-a",warehouseName:"A",
    productId,productName:"Opened",type:"opening",quantityDelta:2,balanceBefore:10,balanceAfter:12,occurredAt,
  });
  await db.collection("products").updateOne({id:productId},{$set:{openingStock:12,openingCost:50,openingWarehouseId:"wh-a","stocks.wh-a":12}});

  await command({type:"opening-stock-correction.update",documentId:legacyId,newOpeningStock:11,openingCost:60,openingWarehouseId:"wh-a",relocateOpeningStock:false});

  const product=await db.collection("products").findOne({id:productId});
  const legacy=await db.collection("documents").findOne({id:legacyId});
  const movements=await db.collection("stockMovements").find({documentId:legacyId}).toArray();
  assert.deepEqual([product.openingStock,product.openingCost,product.stocks["wh-a"]],[11,60,11]);
  assert.deepEqual([legacy.openingCorrection,legacy.title,legacy.openingStockBefore,legacy.openingStockAfter,legacy.openingCostBefore,legacy.openingCostAfter],[true,"تصحيح رصيد البداية",10,11,50,60]);
  assert.deepEqual(movements.map(row=>[row.type,row.quantityDelta]),[["opening",2],["opening-correction-edit",-1]]);
});


test("original opening stock has an explicit reversible delete lifecycle", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const opening = await db.collection("documents").findOne({ kind: "adjustment", title: "رصيد بداية", status: "posted" });
  await command({ type: "opening-stock-initial.void", documentId: opening.id });

  const product = await db.collection("products").findOne({ id: productId });
  const document = await db.collection("documents").findOne({ id: opening.id });
  const movements = await db.collection("stockMovements").find({ documentId: opening.id }).toArray();
  const state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([product.openingStock, product.openingCost, product.openingWarehouseId, product.stocks["wh-a"]], [0, null, null, 0]);
  assert.equal(document.status, "voided");
  assert.deepEqual(movements.map(row => [row.type, row.quantityDelta]), [["opening", 10], ["opening-void", -10]]);
  assert.deepEqual([state.total, state.remaining, state.consumed], [0, 0, 0]);
});

test("opening delete reports the consuming operations and succeeds after they are voided", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const opening = await db.collection("documents").findOne({ kind: "adjustment", title: "رصيد بداية", status: "posted" });
  const saleId = await command({ type: "sale.post", warehouseId: "wh-a", partyId: "customer", paymentMethod: "note", lines: [{ productId, quantity: 4, piecePrice: 100 }] });

  let blocked;
  try { await command({ type: "opening-stock-initial.void", documentId: opening.id }); } catch (error) { blocked = error; }
  assert.equal(blocked?.details?.code, "OPENING_STOCK_BLOCKED");
  assert.equal(blocked?.details?.productId, productId);
  assert.equal(blocked?.details?.blockers?.some(row => row.documentId === saleId), true);
  assert.equal((await db.collection("documents").findOne({ id: opening.id })).status, "posted");

  await command({ type: "sale.void", documentId: saleId });
  await command({ type: "opening-stock-initial.void", documentId: opening.id });
  const product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual([product.openingStock, product.stocks["wh-a"]], [0, 0]);
});

test("voided warehouse transfers restore opening provenance instead of looking consumed", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const transferId = await command({ type: "transfer.post", fromWarehouseId: "wh-a", toWarehouseId: "wh-b", lines: [{ productId, quantity: 6 }] });
  let product = await db.collection("products").findOne({ id: productId });
  let state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, state.allocations["wh-a"], state.allocations["wh-b"]], [10, 0, 4, 6]);

  await command({ type: "transfer.void", documentId: transferId });
  product = await db.collection("products").findOne({ id: productId });
  state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, state.allocations["wh-a"], state.allocations["wh-b"] ?? 0], [10, 0, 10, 0]);

  const opening = await db.collection("documents").findOne({ kind: "adjustment", title: "رصيد بداية", status: "posted" });
  await command({ type: "opening-stock-initial.void", documentId: opening.id });
  product = await db.collection("products").findOne({ id: productId });
  assert.deepEqual([product.stocks["wh-a"], product.stocks["wh-b"] ?? 0], [0, 0]);
});

test("editing a transfer moves opening provenance with the net transfer change", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const transferId = await command({ type: "transfer.post", fromWarehouseId: "wh-a", toWarehouseId: "wh-b", lines: [{ productId, quantity: 7 }] });
  await command({ type: "transfer.update", documentId: transferId, fromWarehouseId: "wh-a", toWarehouseId: "wh-b", lines: [{ productId, quantity: 3 }] });
  const product = await db.collection("products").findOne({ id: productId });
  const state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, state.allocations["wh-a"], state.allocations["wh-b"]], [10, 0, 7, 3]);
});

test("voided inventory corrections restore the exact opening provenance they changed", async () => {
  const productId = await createOpened(10, 50, "wh-a");

  const increaseId = await command({ type: "adjustment.post", warehouseId: "wh-a", reason: "count up", lines: [{ productId, actualQuantity: 15 }] });
  let product = await db.collection("products").findOne({ id: productId });
  let state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed], [10, 0]);
  await command({ type: "adjustment.void", documentId: increaseId });
  product = await db.collection("products").findOne({ id: productId });
  state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, product.stocks["wh-a"]], [10, 0, 10]);

  const decreaseId = await command({ type: "adjustment.post", warehouseId: "wh-a", reason: "count down", lines: [{ productId, actualQuantity: 6 }] });
  product = await db.collection("products").findOne({ id: productId });
  state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed], [6, 4]);
  await command({ type: "adjustment.void", documentId: decreaseId });
  product = await db.collection("products").findOne({ id: productId });
  state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, product.stocks["wh-a"]], [10, 0, 10]);
});

test("adjustment edits reverse their own created stock before consuming opening stock", async () => {
  const productId = await createOpened(10, 50, "wh-a");
  const adjustmentId = await command({ type: "adjustment.post", warehouseId: "wh-a", reason: "count", lines: [{ productId, actualQuantity: 15 }] });
  await command({ type: "adjustment.update", documentId: adjustmentId, reason: "corrected", lines: [{ productId, actualQuantity: 12 }] });
  const product = await db.collection("products").findOne({ id: productId });
  const state = await deriveOpeningStockState(db, undefined, product);
  assert.deepEqual([state.remaining, state.consumed, product.stocks["wh-a"]], [10, 0, 12]);
});
