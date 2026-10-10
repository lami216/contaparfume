import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("warehouses").insertOne({ _id: "a", name: "Main", isSalesDefault: true });
  await db.collection("paymentAccounts").insertOne({ id: "cash", code: "cash", name: "Cash", balance: 1000, isActive: true });
  await db.collection("parties").insertMany([
    { id: "customer", name: "Customer", partyType: "customer", receivable: 0, payable: 0, net: 0 },
    { id: "supplier", name: "Supplier", partyType: "supplier", receivable: 0, payable: 0, net: 0 },
  ]);
});
const command = body => db.transaction(session => execute(db, session, body));

async function setupPerfume() {
  const originalId = await command({
    type: "product.create", name: "Perfume", pieceCost: 100, piecePrice: 150,
    openingStock: 1, openingWarehouseId: "a",
  });
  const bottleId = await command({ type: "perfume-bottle.create", name: "Bottle 5ml", sizeMl: 5, cost: 3 });
  await command({
    type: "decant-purchase.post", paymentMethod: "cash",
    lines: [{ productId: bottleId, quantity: 10, unitPrice: 5 }],
  });
  await command({
    type: "perfume-split.post", sourceProductId: originalId, warehouseId: "a",
    divisionsCount: 10, salePrice: 30,
  });
  const decant = await db.collection("products").findOne({ perfumeForm: "decant", parentProductId: originalId });
  assert.ok(decant, "split creates a decant product with ten inventory units");
  return { originalId, bottleId, decantId: decant.id };
}

test("decant sale recognizes both liquid and bottle cost, and void restores stock and records financial reversal", async () => {
  const { decantId, bottleId } = await setupPerfume();
  const cashBeforeSale = (await db.collection("paymentAccounts").findOne({ id: "cash" })).balance;
  assert.equal(cashBeforeSale, 950);
  const saleId = await command({
    type: "decant-sale.post", partyId: "customer", paymentMethod: "cash",
    lines: [{ productId: decantId, bottleProductId: bottleId, quantity: 2, unitPrice: 30 }],
  });
  const invoice = await db.collection("documents").findOne({ id: saleId });
  assert.equal(invoice.kind, "decant-sale");
  assert.deepEqual([invoice.total, invoice.paidTotal, invoice.dueTotal], [60, 60, 0]);
  assert.equal(invoice.lines[0].costAtSale, 15);
  assert.equal(invoice.lines[0].grossProfit, 30);
  assert.equal(invoice.lines[0].perfumeAllocations[0].quantity, 2);
  assert.equal((await db.collection("products").findOne({ id: decantId })).stocks.a, 8);
  assert.equal((await db.collection("products").findOne({ id: bottleId })).stocks.a, 8);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, 1010);

  await command({ type: "decant-sale.void", documentId: saleId });
  assert.equal((await db.collection("documents").findOne({ id: saleId })).status, "voided");
  const decant = await db.collection("products").findOne({ id: decantId });
  assert.equal(decant.stocks.a, 10);
  assert.equal(decant.perfumeLots.reduce((n, lot) => n + lot.remainingQuantity, 0), 10);
  assert.equal((await db.collection("products").findOne({ id: bottleId })).stocks.a, 10);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, cashBeforeSale);
  assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId, status: "reversed" }), 1);
  assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId, isReversal: true }), 1);
});

test("normal invoices, manual correction, and opening edits refuse decant stock bypass", async () => {
  const { decantId, bottleId } = await setupPerfume();
  const regularId = await command({
    type: "product.create", name: "Regular", pieceCost: 20, openingStock: 2, openingWarehouseId: "a",
  });
  const before = (await db.collection("products").findOne({ id: decantId })).perfumeLots;
  await assert.rejects(command({
    type: "sale.post", warehouseId: "a", paymentMethod: "cash",
    lines: [{ productId: decantId, quantity: 1, piecePrice: 50 }],
  }), /فاتورة التقسيمات/);
  await assert.rejects(command({
    type: "purchase.post", warehouseId: "a", paymentMethod: "cash",
    lines: [{ productId: bottleId, quantity: 1, unitPrice: 5 }],
  }), /فاتورة الشراء العادية/);
  await assert.rejects(command({
    type: "adjustment.post", warehouseId: "a", reason: "manual",
    lines: [{ productId: decantId, actualQuantity: 12 }],
  }), /لا يمكن تصحيح مخزون التقسيمات/);
  await assert.rejects(command({
    type: "product.update", id: decantId, name: "Decant",
    replaceOpeningStock: true, openingStock: 10, openingWarehouseId: "a",
  }), /رصيد بداية المنتجات المولدة/);
  const saleId = await command({
    type: "sale.post", warehouseId: "a", paymentMethod: "cash",
    lines: [{ productId: regularId, quantity: 1, piecePrice: 60 }],
  });
  await assert.rejects(command({
    type: "sale.update", documentId: saleId, paymentMethod: "cash",
    lines: [{ productId: decantId, quantity: 1, piecePrice: 50 }],
  }), /فاتورة التقسيمات/);
  assert.equal((await db.collection("documents").findOne({ id: saleId })).lines[0].productId, regularId);
  assert.deepEqual((await db.collection("products").findOne({ id: decantId })).perfumeLots, before);
  assert.equal((await db.collection("products").findOne({ id: decantId })).stocks.a, 10);
});

test("decant invoices reject unknown parties and missing bottle purchase cost without phantom entries", async () => {
  const { bottleId } = await setupPerfume();
  await assert.rejects(command({
    type: "decant-purchase.post", partyId: "missing", paymentMethod: "cash",
    lines: [{ productId: bottleId, quantity: 1, unitPrice: 6 }],
  }), /غير موجود أو مؤرشف/);
  const id = await command({ type: "perfume-bottle.create", name: "Unpurchased 7ml", sizeMl: 7, cost: 3 });
  await db.collection("products").updateOne({ id }, { $set: { "stocks.a": 1 } });
  await assert.rejects(command({
    type: "decant-sale.post", paymentMethod: "cash",
    lines: [{ productId: id, quantity: 1, unitPrice: 10 }],
  }), /لا توجد تكلفة شراء معتمدة/);
  assert.equal(await db.collection("documents").countDocuments({ kind: "decant-sale" }), 0);
  assert.equal((await db.collection("products").findOne({ id })).stocks.a, 1);
});

test("generic adjustment lifecycle cannot void or edit perfume conversion records", async () => {
  await setupPerfume();
  const split = await db.collection("documents").findOne({ perfumeConversionType: "perfume-split", status: "posted" });
  assert.ok(split);
  const before = await db.collection("products").findOne({ perfumeForm: "decant" });
  await assert.rejects(command({
    type: "adjustment.void", documentId: split.id,
  }), /لا يمكن إلغاء عملية مخزون تقسيمات/);
  await assert.rejects(command({
    type: "adjustment.update", documentId: split.id, reason: "wrong path",
    lines: [{ productId: before.id, actualQuantity: 0 }],
  }), /لا يمكن تعديل عملية مخزون تقسيمات/);
  assert.equal((await db.collection("documents").findOne({ id: split.id })).status, "posted");
  assert.deepEqual((await db.collection("products").findOne({ id: before.id })).perfumeLots, before.perfumeLots);
});

test("credit decant sales and purchases change party balances only and safely reverse", async () => {
  const { decantId, bottleId } = await setupPerfume();
  const cashBefore = (await db.collection("paymentAccounts").findOne({ id: "cash" })).balance;
  const purchaseId = await command({
    type: "decant-purchase.post", partyId: "supplier", paymentMethod: "note",
    lines: [{ productId: bottleId, quantity: 1, unitPrice: 7 }],
  });
  assert.equal((await db.collection("parties").findOne({ id: "supplier" })).payable, 7);
  assert.equal((await db.collection("documents").findOne({ id: purchaseId })).dueTotal, 7);
  assert.equal(await db.collection("financialMovements").countDocuments({ documentId: purchaseId }), 0);
  const saleId = await command({
    type: "decant-sale.post", partyId: "customer", paymentMethod: "note",
    lines: [{ productId: decantId, bottleProductId: bottleId, quantity: 1, unitPrice: 30 }],
  });
  assert.equal((await db.collection("parties").findOne({ id: "customer" })).receivable, 30);
  assert.equal((await db.collection("documents").findOne({ id: saleId })).dueTotal, 30);
  assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId }), 0);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, cashBefore);
  await command({ type: "decant-sale.void", documentId: saleId });
  await command({ type: "decant-purchase.void", documentId: purchaseId });
  assert.equal((await db.collection("parties").findOne({ id: "customer" })).receivable, 0);
  assert.equal((await db.collection("parties").findOne({ id: "supplier" })).payable, 0);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, cashBefore);
  assert.equal((await db.collection("products").findOne({ id: bottleId })).lastPurchaseCost, 5);
});
