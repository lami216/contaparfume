import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatQuantity,
  quantity,
  stockInWarehouse,
  totalProductStock,
} from "../app/domain.ts";

const nonLatinDigit = /[٠-٩۰-۹]/;

test("shared display formatters always emit Latin digits", () => {
  const values = [
    formatNumber(1211),
    formatQuantity(222),
    formatMoney(17700),
    formatDate(new Date(2026, 7, 18)),
    formatDateTime(new Date(2026, 7, 18, 14, 5)),
  ];

  assert.equal(formatNumber(1211), "1 211");
  assert.equal(formatMoney(17700), "17 700 MRU");
  assert.match(formatDate(new Date(2026, 7, 18)), /18\/08\/2026/);
  assert.equal(values.some((value) => nonLatinDigit.test(value)), false);
});

test("quantity has no unit suffix and warehouse stock never falls back globally", () => {
  const product = { stocks: { warehouseA: 10 } };
  assert.equal(quantity(4), "4");
  assert.equal(stockInWarehouse(product, "warehouseB"), 0);
  assert.equal(stockInWarehouse(product, "warehouseA"), 10);
  assert.equal(totalProductStock(product), 10);
});

test("commercial documents display their numeric sequence while technical references remain hidden", async () => {
  const { displayDocumentNumber } = await import("../app/domain.ts");
  assert.equal(displayDocumentNumber({ kind: "sale", number: "SAL-internal", sequence: 515 }), "515");
  assert.equal(displayDocumentNumber({ kind: "purchase", number: "PUR-internal", sequence: 12 }), "12");
  assert.equal(displayDocumentNumber({ kind: "transfer", number: "TRF-visible" }), "TRF-visible");
});
