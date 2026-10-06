import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { consumePerfumeLot, correctPerfumeLotYield, createOpeningPerfumeLot, perfumeLotBookValue } from "../app/perfume-stock-reconciliation.ts";

const lot = (overrides = {}) => ({
  id: "lot-1",
  sourceProductId: "perfume-1",
  sourceProductName: "Test",
  originalQuantity: 8,
  remainingQuantity: 8,
  liquidUnitCost: 100,
  bottleCost: 0,
  landedUnitCost: 100,
  decantSizeMl: null,
  stocks: { wh1: 8 },
  createdAt: "2026-01-01T00:00:00.000Z",
  conversionDocumentId: "doc-1",
  ...overrides,
});

test("opening decant stock carries only the entered remaining book value", () => {
  const opened = createOpeningPerfumeLot({
    id: "lot-opening",
    sourceProductId: "perfume-1",
    sourceProductName: "Old opened perfume",
    warehouseId: "wh1",
    quantity: 4,
    remainingValue: 400,
    createdAt: "2026-01-01T00:00:00.000Z",
    conversionDocumentId: "opening-doc",
  });
  assert.equal(opened.remainingQuantity, 4);
  assert.equal(opened.liquidUnitCost, 100);
  assert.equal(perfumeLotBookValue(opened), 400);
  assert.equal(opened.openingBalance, true);
});

test("yield correction from 8 to 9 preserves the lot book value", () => {
  const result = correctPerfumeLotYield(lot(), "wh1", 9);
  assert.equal(result.afterOriginalQuantity, 9);
  assert.equal(result.afterRemainingQuantity, 9);
  assert.equal(result.remainingBookValue, 800);
  assert.ok(Math.abs(result.afterUnitCost - (800 / 9)) < 1e-10);
  assert.ok(Math.abs(perfumeLotBookValue(result.lot) - 800) < 1e-8);
});

test("yield correction after historical sales revalues only the unsold balance", () => {
  const result = correctPerfumeLotYield(lot({ remainingQuantity: 1, stocks: { wh1: 1 } }), "wh1", 2);
  assert.equal(result.afterOriginalQuantity, 9);
  assert.equal(result.afterRemainingQuantity, 2);
  assert.equal(result.remainingBookValue, 100);
  assert.equal(result.afterUnitCost, 50);
});

test("finding one extra unit after the old lot was fully sold creates no new cost", () => {
  const result = correctPerfumeLotYield(lot({ remainingQuantity: 0, stocks: { wh1: 0 } }), "wh1", 1);
  assert.equal(result.afterOriginalQuantity, 9);
  assert.equal(result.afterRemainingQuantity, 1);
  assert.equal(result.afterUnitCost, 0);
  assert.equal(perfumeLotBookValue(result.lot), 0);
});

test("yield correction cannot erase nonzero book value; that must be consumption", () => {
  assert.throws(() => correctPerfumeLotYield(lot({ remainingQuantity: 1, stocks: { wh1: 1 } }), "wh1", 0), /استهلاك\/هالك/);
});

test("samples and waste remove quantity and its exact liquid cost", () => {
  const result = consumePerfumeLot(lot({ originalQuantity: 10, remainingQuantity: 1, stocks: { wh1: 1 } }), "wh1", 1);
  assert.equal(result.lot.remainingQuantity, 0);
  assert.equal(result.lot.stocks.wh1, 0);
  assert.equal(result.inventoryLoss, 100);
});

test("decant reconciliation commands are specialized, reversible and noncash", async () => {
  const [route, commands, reports, ui] = await Promise.all([
    readFile(new URL("../app/api/command/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/command/base-route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/reports.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/perfume-divisions.tsx", import.meta.url), "utf8"),
  ]);
  for (const command of ["perfume-opening.post", "perfume-lot-consume.post", "perfume-lot-correct.post", "perfume-stock-operation.void"]) {
    assert.match(route, new RegExp(command.replaceAll(".", "\\.")));
  }
  assert.match(commands, /perfumeLotBefore/);
  assert.match(commands, /perfumeLotAfter/);
  assert.match(commands, /perfumeLotEquals/);
  assert.match(commands, /لا يمكن إلغاء الحركة لأن دفعة التقسيم تغيرت بعدها/);
  assert.match(commands, /inventoryLoss:consumed\.inventoryLoss/);
  const openingStart = commands.indexOf('if (type === "perfume-opening.post")');
  const openingEnd = commands.indexOf('if(type==="perfume-lot-consume.post")', openingStart);
  assert.ok(openingStart >= 0 && openingEnd > openingStart);
  assert.doesNotMatch(commands.slice(openingStart, openingEnd), /financialMovement\(/);
  assert.match(reports, /netOperatingResult:p\.profit-expenses-inventoryLoss/);
  assert.match(reports, /productInventoryValueInWarehouse/);
  assert.match(ui, /رصيد افتتاحي لعطر مفتوح قديم/);
  assert.match(ui, /استهلاك \/ هالك \/ عينات/);
  assert.match(ui, /تصحيح ناتج التقسيم/);
});
