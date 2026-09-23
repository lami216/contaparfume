import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";
import { resolveProductCost } from "../lib/product-cost.ts";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
after(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await db.collection("warehouses").insertMany([{ _id: "a", name: "A", isSalesDefault: true }, { _id: "b", name: "B" }]);
  await db.collection("parties").insertMany([{ id: "customer", name: "Customer", partyType: "customer", receivable: 0, payable: 0, net: 0 }, { id: "supplier", name: "Supplier", partyType: "supplier", receivable: 0, payable: 0, net: 0 }]);
  await db.collection("paymentAccounts").insertOne({ id: "cash", code: "cash", name: "Cash", isActive: true, balance: 1000 });
});
const command = body => db.transaction(session => execute(db, session, body));

test("a catalog-only product cannot enter stock through adjustment even with a forged cost", async () => {
  const id = await command({ type: "product.create", name: "Catalog only", pieceCost: 99, openingStock: 0 });
  await assert.rejects(command({ type: "adjustment.post", warehouseId: "a", reason: "count", lines: [{ productId: id, actualQuantity: 2, purchaseCost: 99 }] }), /قبل دخوله إليه/);
  const product = await db.collection("products").findOne({ id });
  assert.deepEqual(product.stocks, {});
  assert.equal(product.lastPurchaseCost ?? null, null);
  assert.equal(await db.collection("documents").countDocuments({ kind: "adjustment" }), 0);
  assert.equal(await db.collection("stockMovements").countDocuments({ productId: id }), 0);
});

test("an exhausted product with a real opening origin can be counted back into the same warehouse without changing cost", async () => {
  const id = await command({ type: "product.create", name: "Opened", pieceCost: 50, openingStock: 2, openingWarehouseId: "a" });
  await command({ type: "sale.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId: id, quantity: 2, piecePrice: 100 }] });
  let product = await db.collection("products").findOne({ id });
  assert.equal(product.stocks.a, 0);
  assert.equal(product.lastPurchaseCost, 50);
  await command({ type: "adjustment.post", warehouseId: "a", reason: "physical count", lines: [{ productId: id, actualQuantity: 3 }] });
  product = await db.collection("products").findOne({ id });
  assert.deepEqual([product.stocks.a, product.lastPurchaseCost, product.lastPurchaseCostSource], [3, 50, "opening"]);
  const adjustment = await db.collection("documents").findOne({ kind: "adjustment", title: "physical count" });
  assert.equal(adjustment.lines[0].unitPrice, 50);
});

test("warehouse footprint survives zero stock and transfer history, while a voided origin cannot be recreated by adjustment", async () => {
  const id = await command({ type: "product.create", name: "Purchased", openingStock: 0 });
  const purchaseId = await command({ type: "purchase.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId: id, quantity: 2, unitPrice: 70 }] });
  await command({ type: "transfer.post", fromWarehouseId: "a", toWarehouseId: "b", lines: [{ productId: id, quantity: 2 }] });
  await command({ type: "sale.post", warehouseId: "b", paymentMethod: "cash", lines: [{ productId: id, quantity: 2, piecePrice: 100 }] });
  await command({ type: "adjustment.post", warehouseId: "b", reason: "found one", lines: [{ productId: id, actualQuantity: 1 }] });
  assert.equal((await db.collection("products").findOne({ id })).stocks.b, 1);

  const second = await command({ type: "product.create", name: "Voided purchase", openingStock: 0 });
  const secondPurchase = await command({ type: "purchase.post", warehouseId: "a", paymentMethod: "cash", lines: [{ productId: second, quantity: 2, unitPrice: 80 }] });
  await command({ type: "purchase.void", documentId: secondPurchase });
  await assert.rejects(command({ type: "adjustment.post", warehouseId: "a", reason: "should fail", lines: [{ productId: second, actualQuantity: 1 }] }), /لا يملك رصيد بداية أو فاتورة شراء قائمة/);
  assert.equal((await db.collection("products").findOne({ id: second })).stocks.a, 0);
  assert.ok(await db.collection("documents").findOne({ id: purchaseId, status: "posted" }));
});

test("ordinary and legacy adjustment prices never become authoritative product cost", async () => {
  const fake = { id: "p", lastPurchaseCost: 35, lastPurchaseCostSource: "adjustment", openingCost: null };
  const docs = [{ id: "adj", kind: "adjustment", status: "posted", occurredAt: "2026-01-01T00:00:00.000Z", lines: [{ productId: "p", quantity: 3, unitPrice: 35 }] }];
  assert.deepEqual(resolveProductCost(fake, docs), { cost: null, source: null, at: null });
});

test("invoice posting rejects partial or over payment and keeps note invoices wholly on the party account", async () => {
  const id = await command({ type: "product.create", name: "Tea", pieceCost: 50, openingStock: 5, openingWarehouseId: "a", piecePrice: 100 });
  const before = (await db.collection("paymentAccounts").findOne({ id: "cash" })).balance;
  await assert.rejects(command({ type: "sale.post", warehouseId: "a", partyId: "customer", paymentMethod: "cash", paidAmount: 40, lines: [{ productId: id, quantity: 1, piecePrice: 100 }] }), /الدفع الجزئي داخل الفاتورة غير مدعوم/);
  await assert.rejects(command({ type: "sale.post", warehouseId: "a", partyId: "customer", paymentMethod: "note", paidAmount: 40, lines: [{ productId: id, quantity: 1, piecePrice: 100 }] }), /الدفع الجزئي داخل الفاتورة غير مدعوم/);
  await assert.rejects(command({ type: "purchase.post", warehouseId: "a", partyId: "supplier", paymentMethod: "cash", cashAmount: 120, lines: [{ productId: id, quantity: 1, unitPrice: 80 }] }), /الدفع الجزئي داخل الفاتورة غير مدعوم/);
  assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash" })).balance, before);
  assert.equal((await db.collection("products").findOne({ id })).stocks.a, 5);

  const saleId = await command({ type: "sale.post", warehouseId: "a", partyId: "customer", paymentMethod: "note", paidAmount: 0, lines: [{ productId: id, quantity: 1, piecePrice: 100 }] });
  let invoice = await db.collection("documents").findOne({ id: saleId });
  assert.deepEqual([invoice.total, invoice.paidTotal, invoice.cashAmount, invoice.dueTotal], [100, 0, 0, 100]);
  assert.equal((await db.collection("parties").findOne({ id: "customer" })).receivable, 100);
  assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId, type: "sale" }), 0);

  const receiptId = await command({ type: "party-cash.post", partyId: "customer", direction: "receive", amount: 40, paymentMethod: "cash" });
  assert.equal((await db.collection("parties").findOne({ id: "customer" })).receivable, 60);
  invoice = await db.collection("documents").findOne({ id: saleId });
  assert.deepEqual([invoice.paidTotal, invoice.dueTotal], [0, 100], "receipt history stays separate from the invoice");
  assert.ok(await db.collection("documents").findOne({ id: receiptId, kind: "payment" }));
});

test("stock adjustment UI has no purchase-cost field and filters catalog-only products by selected-warehouse footprint", () => {
  const app = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  const tableStart = app.indexOf("function StockDraftTable"), transferStart = app.indexOf("function Transfer", tableStart);
  const adjustmentArea = app.slice(tableStart, transferStart);
  assert.ok(tableStart >= 0 && transferStart > tableStart);
  assert.doesNotMatch(adjustmentArea, /purchaseCost|تكلفة الوحدة/);
  const pickerStart = app.indexOf("function ProductSearchPicker"), pickerEnd = app.indexOf("function SearchProducts", pickerStart);
  const picker = app.slice(pickerStart, pickerEnd);
  assert.match(picker, /mode !== "adjustment"/);
  assert.ok(picker.includes("Object.prototype.hasOwnProperty.call(product.stocks"));
  assert.match(picker, /data.movements.some/);
});
