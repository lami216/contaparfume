import assert from "node:assert/strict";
import test from "node:test";
import { sqliteHarness } from "./sqlite-harness.mjs";
import { execute } from "../app/api/command/route.ts";

test("decant sale and bottle purchase post and void preserve stock and accounting", async () => {
  const harness = await sqliteHarness();
  const db = harness.db;
  await harness.reset(); // Remove seeded sales-default warehouses before installing test fixtures.
  const wh = "test-warehouse";
  const command = body => db.transaction(session => execute(db, session, body));
  try {
    await db.collection("warehouses").insertOne({
      id: wh, name: "Test warehouse", isSalesDefault: true, isArchived: false,
    });
    await db.collection("paymentAccounts").insertOne({
      id: "cash-test", code: "cash-test", name: "Cash", balance: 1000,
      isActive: true, isArchived: false,
    });
    await db.collection("parties").insertMany([
      { id: "customer-test", name: "Customer", partyType: "customer", receivable: 0, payable: 0, net: 0 },
      { id: "supplier-test", name: "Supplier", partyType: "supplier", receivable: 0, payable: 0, net: 0 },
    ]);
    await db.collection("products").insertMany([
      {
        id: "decant-test", name: "Decant", perfumeForm: "decant",
        stocks: { [wh]: 4 }, piecePrice: 100,
        perfumeLots: [{
          id: "lot-test", sourceProductId: "original-perfume",
          sourceProductName: "Source perfume", originalQuantity: 4,
          remainingQuantity: 4, liquidUnitCost: 10, landedUnitCost: 10,
          stocks: { [wh]: 4 }, createdAt: "2026-01-01T00:00:00.000Z",
          conversionDocumentId: "split-test",
        }],
      },
      {
        id: "bottle-test", name: "Bottle", perfumeForm: "bottle",
        stocks: { [wh]: 10 }, pieceCost: 5, lastPurchaseCost: 5, decantSizeMl: 10,
      },
    ]);

    const saleId = await command({
      type: "decant-sale.post", paymentMethod: "cash-test", partyId: "customer-test",
      cashAmount: 200,
      lines: [{ productId: "decant-test", quantity: 2, unitPrice: 100, bottleProductId: "bottle-test" }],
    });
    const sale = await db.collection("documents").findOne({ id: saleId });
    assert.equal(sale.kind, "decant-sale");
    assert.equal(sale.status, "posted");
    assert.equal(sale.total, 200);
    assert.equal(sale.lines[0].perfumeAllocations[0].quantity, 2);
    assert.equal(sale.lines[0].grossProfit, 170);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).stocks[wh], 2);
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 8);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).perfumeLots[0].remainingQuantity, 2);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 1200);
    assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId }), 1);

    const saleUpdated = await command({
      type: "decant-sale.update", documentId: saleId, expectedRevision: 0,
      paymentMethod: "note", partyId: "customer-test", cashAmount: 0,
      lines: [{ productId: "decant-test", quantity: 1, unitPrice: 120, bottleProductId: "bottle-test" }],
    });
    assert.equal(saleUpdated, saleId);
    const saleRevision = await db.collection("documents").findOne({ id: saleId });
    assert.equal(saleRevision.number, sale.number);
    assert.equal(saleRevision.sequence, sale.sequence);
    assert.equal(saleRevision.revision, 1);
    assert.equal(saleRevision.editHistory.length, 1);
    assert.equal(saleRevision.editHistory[0].total, 200);
    assert.equal(saleRevision.total, 120);
    assert.equal(saleRevision.dueTotal, 120);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 1000);
    assert.equal((await db.collection("parties").findOne({ id: "customer-test" })).receivable, 120);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).stocks[wh], 3);
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 9);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).perfumeLots[0].remainingQuantity, 3);
    assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId }), 0);

    await assert.rejects(command({
      type: "decant-sale.update", documentId: saleId, expectedRevision: 0,
      paymentMethod: "note", partyId: "customer-test", cashAmount: 0,
      lines: [{ productId: "decant-test", quantity: 2, unitPrice: 100, bottleProductId: "bottle-test" }],
    }), /تغيرت الفاتورة/);
    await assert.rejects(command({
      type: "decant-sale.update", documentId: saleId, expectedRevision: 1,
      paymentMethod: "cash-test", partyId: "customer-test", cashAmount: 10000,
      lines: [{ productId: "decant-test", quantity: 100, unitPrice: 100, bottleProductId: "bottle-test" }],
    }), /غير كاف/);
    assert.equal((await db.collection("documents").findOne({ id: saleId })).revision, 1);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).stocks[wh], 3);
    assert.equal((await db.collection("parties").findOne({ id: "customer-test" })).receivable, 120);

    await command({ type: "decant-sale.void", documentId: saleId });
    assert.equal((await db.collection("documents").findOne({ id: saleId })).status, "voided");
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).stocks[wh], 4);
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 10);
    assert.equal((await db.collection("products").findOne({ id: "decant-test" })).perfumeLots[0].remainingQuantity, 4);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 1000);
    assert.equal((await db.collection("parties").findOne({ id: "customer-test" })).receivable, 0);
    assert.equal(await db.collection("financialMovements").countDocuments({ documentId: saleId }), 0);

    const purchaseId = await command({
      type: "decant-purchase.post", paymentMethod: "note", partyId: "supplier-test", cashAmount: 0,
      lines: [{ productId: "bottle-test", quantity: 3, unitPrice: 7 }],
    });
    const purchase = await db.collection("documents").findOne({ id: purchaseId });
    assert.equal(purchase.kind, "decant-purchase");
    assert.equal(purchase.status, "posted");
    assert.equal(purchase.total, 21);
    assert.equal(purchase.dueTotal, 21);
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 13);
    assert.equal((await db.collection("parties").findOne({ id: "supplier-test" })).payable, 21);

    const purchaseUpdated = await command({
      type: "decant-purchase.update", documentId: purchaseId, expectedRevision: 0,
      paymentMethod: "cash-test", partyId: "supplier-test", cashAmount: 20,
      lines: [{ productId: "bottle-test", quantity: 2, unitPrice: 10 }],
    });
    assert.equal(purchaseUpdated, purchaseId);
    const purchaseRevision = await db.collection("documents").findOne({ id: purchaseId });
    assert.equal(purchaseRevision.number, purchase.number);
    assert.equal(purchaseRevision.sequence, purchase.sequence);
    assert.equal(purchaseRevision.revision, 1);
    assert.equal(purchaseRevision.editHistory[0].total, 21);
    assert.equal(purchaseRevision.total, 20);
    assert.equal(purchaseRevision.dueTotal, 0);
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 12);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 980);
    assert.equal((await db.collection("parties").findOne({ id: "supplier-test" })).payable, 0);
    assert.equal(await db.collection("financialMovements").countDocuments({ documentId: purchaseId }), 1);

    await assert.rejects(command({
      type: "decant-purchase.update", documentId: purchaseId, expectedRevision: 1,
      paymentMethod: "note", partyId: "supplier-test", cashAmount: 0,
      lines: [{ productId: "bottle-test", quantity: 1, unitPrice: 0 }],
    }), /غير صالح/);
    assert.equal((await db.collection("documents").findOne({ id: purchaseId })).revision, 1);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 980);
    await command({ type: "decant-purchase.void", documentId: purchaseId });
    assert.equal((await db.collection("documents").findOne({ id: purchaseId })).status, "voided");
    assert.equal((await db.collection("products").findOne({ id: "bottle-test" })).stocks[wh], 10);
    assert.equal((await db.collection("parties").findOne({ id: "supplier-test" })).payable, 0);
    assert.equal((await db.collection("paymentAccounts").findOne({ id: "cash-test" })).balance, 1000);
  } finally {
    await harness.close();
  }
});
