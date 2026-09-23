import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, beforeEach } from "node:test";
import { classifyStockMovementType, isOpeningStockCorrectionDocument, isOpeningStockDocument, optionalFiniteNumber, stockMovementMatchesFilter } from "../app/stock-movement.ts";
import { buildReport } from "../lib/reports.ts";
import { sqliteHarness } from "./sqlite-harness.mjs";

let harness, db;
before(async () => { harness = await sqliteHarness(); db = harness.db; });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("optional opening-stock metadata never invents zero for missing values", () => {
  assert.equal(optionalFiniteNumber(null), null);
  assert.equal(optionalFiniteNumber(undefined), null);
  assert.equal(optionalFiniteNumber(""), null);
  assert.equal(optionalFiniteNumber("no-number"), null);
  assert.equal(optionalFiniteNumber(0), 0);
  assert.equal(optionalFiniteNumber("0"), 0);
  assert.equal(optionalFiniteNumber("12.5"), 12.5);
});

test("opening-stock movement classification repairs current and historical correction labels", () => {
  const current = { kind: "adjustment", number: "OPEN-COR-1", title: "تصحيح رصيد البداية", openingCorrection: true, openingStockBefore: 10, openingStockAfter: 8 };
  const oldAdd = { kind: "adjustment", number: "OPEN-OLD-2", title: "إضافة رصيد افتتاحي" };
  const initial = { kind: "adjustment", number: "OPEN-1", title: "رصيد بداية", openingStockAfter: 10 };
  assert.equal(classifyStockMovementType("unknown", current), "opening-correction");
  assert.equal(classifyStockMovementType("opening", oldAdd), "opening-correction");
  assert.equal(classifyStockMovementType("unknown", initial), "opening");
  assert.equal(isOpeningStockCorrectionDocument(oldAdd), true);
  assert.equal(isOpeningStockDocument(initial), true);
  assert.equal(stockMovementMatchesFilter("sale-edit", "sale"), true);
  assert.equal(stockMovementMatchesFilter("purchase-void", "purchase"), true);
  assert.equal(stockMovementMatchesFilter("opening-correction", "opening"), false);
});

test("stock report finds historical opening edits even when their stored movement type was not canonical", async () => {
  await db.collection("products").insertOne({ id: "p", name: "منتج", sku: "P-1", stocks: { w: 8 } });
  await db.collection("documents").insertMany([
    { id: "old", number: "OPEN-OLD-2", kind: "adjustment", status: "posted", title: "إضافة رصيد افتتاحي", occurredAt: "2026-08-10T12:00:00.000Z", total: 0, paidTotal: 0, dueTotal: 0, lines: [] },
    { id: "current", number: "OPEN-COR-3", kind: "adjustment", status: "posted", title: "تصحيح رصيد البداية", openingCorrection: true, openingStockBefore: 10, openingStockAfter: 8, occurredAt: "2026-08-11T12:00:00.000Z", total: 0, paidTotal: 0, dueTotal: 0, lines: [] },
  ]);
  await db.collection("stockMovements").insertMany([
    { id: "m-old", documentId: "old", occurredAt: "2026-08-10T12:00:00.000Z", productId: "p", productName: "منتج", warehouseId: "w", warehouseName: "الرئيسي", type: "opening", balanceBefore: 5, quantityDelta: 5, balanceAfter: 10, documentNumber: "OPEN-OLD-2" },
    { id: "m-current", documentId: "current", occurredAt: "2026-08-11T12:00:00.000Z", productId: "p", productName: "منتج", warehouseId: "w", warehouseName: "الرئيسي", type: "opening-correction", balanceBefore: 10, quantityDelta: -2, balanceAfter: 8, documentNumber: "OPEN-COR-3" },
  ]);
  const report = await buildReport(db, { type: "stock", from: "2026-08-01", to: "2026-08-31", movementType: "opening-correction", page: 1, pageSize: 100 });
  assert.equal(report.meta.totalRows, 2);
  assert.deepEqual(report.rows.map(row => row.movementType), ["opening-correction", "opening-correction"]);
  assert.equal(report.summary.netChange, 3);
});

test("bootstrap, reports, UI history and official records share the opening-stock classifier", () => {
  const bootstrap = readFileSync(new URL("../app/api/bootstrap/route.ts", import.meta.url), "utf8");
  const reports = readFileSync(new URL("../lib/reports.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("../app/opening-stock-history.tsx", import.meta.url), "utf8");
  assert.match(bootstrap, /classifyStockMovementType/);
  assert.match(reports, /stockMovementMatchesFilter/);
  assert.match(app, /"opening-correction":"تصحيح رصيد البداية"/);
  assert.match(app, /OpeningStockHistory/);
  assert.match(app, /isOpeningStockDocument\(record\)/);
  assert.match(history, /money\(costAfter\)/);
  assert.match(history, /number\(delta\)/);
});
