import test from "node:test";
import assert from "node:assert/strict";
import { buildWarehouseInventory, inventoryProductUnit, inventoryQuantityLabel } from "../app/warehouse-inventory-model.ts";

function product(id, categoryId, stocks, cost, extra = {}) {
  return { id, name: id, sku: id, barcode: `barcode-${id}`, categoryId, stocks, lastPurchaseCost: cost, ...extra };
}
function fixture() {
  return [
    product("full-a", "adopted-fragrances", { w1: 2, w2: 3, archived: 99 }, 100, { perfumeForm: "full" }),
    product("custom-b", "custom", { w1: 1, w2: 0 }, 200),
    product("bottle", "system:perfume:bottles", { w1: 4, w2: 6 }, 10, { perfumeForm: "bottle" }),
    product("liquid", "system:perfume:decants", { w1: 40, w2: 60 }, 999, {
      perfumeForm: "decant", perfumeStockUnit: "ml",
      perfumeLots: [{ id: "lot", stocks: { w1: 40, w2: 60 }, liquidUnitCost: 2 }],
    }),
    product("zero", "custom", { w1: 0, w2: 0 }, 100),
  ];
}
const view = (extra = {}) => buildWarehouseInventory({ products: fixture(), warehouseIds: ["w1"], ...extra });

test("one warehouse and all active warehouses share a distinct-product and unit-safe summary", () => {
  assert.deepEqual(view().summary, { count: 4, pieces: 7, millilitres: 40, hasPieces: true, hasMillilitres: true, value: 520 });
  assert.deepEqual(view({ warehouseIds: ["w1", "w2"] }).summary, { count: 4, pieces: 16, millilitres: 100, hasPieces: true, hasMillilitres: true, value: 1000 });
  assert.equal(view().products.length, 4);
});

test("protected and adopted categories filter by identity and preserve per-lot value", () => {
  assert.deepEqual(view({ categoryId: "system:perfume:decants" }).summary, { count: 1, pieces: 0, millilitres: 40, hasPieces: false, hasMillilitres: true, value: 80 });
  assert.equal(view({ categoryId: "system:perfume:bottles" }).summary.value, 40);
  assert.equal(view({ categoryId: "adopted-fragrances" }).summary.value, 200);
  assert.deepEqual(view({ categoryId: "custom" }).products.map(row => row.id), ["custom-b"]);
  assert.equal(view({ categoryId: "missing" }).summary.count, 0);
});

test("name sku barcode and category searches use the same selected rows for every total", () => {
  assert.deepEqual(view({ query: " BARCODE-FULL-A " }).products.map(row => row.id), ["full-a"]);
  assert.equal(view({ query: " BARCODE-FULL-A " }).summary.value, 200);
  assert.equal(view({ query: "custom", categoryId: "system:perfume:decants" }).summary.count, 0);
  const products = fixture(); products[0].name = "عطر خاص"; products[0].sku = "0012";
  assert.equal(view({ products, query: "عطر" }).summary.pieces, 2);
  assert.equal(view({ products, query: "0012" }).summary.value, 200);
});

test("positive retained archived products remain visible and empty scopes have numeric zero totals", () => {
  const products = fixture(); products[0].isArchived = true;
  assert(view({ products }).products.some(row => row.id === "full-a"));
  assert.equal(view({ warehouseIds: [] }).summary.value, 0);
  assert.equal(view({ query: "absent" }).summary.pieces, 0);
});

test("mixed unit labels never add liquid millilitres to ordinary and legacy piece stock", () => {
  const labels = { pieces: "وحدة", millilitres: "مل", format: String };
  assert.equal(inventoryQuantityLabel(view().summary, labels), "7 وحدة · 40 مل");
  assert.equal(inventoryQuantityLabel(view({ categoryId: "system:perfume:decants" }).summary, labels), "40 مل");
  assert.equal(inventoryQuantityLabel(view({ query: "absent" }).summary, labels), "0 وحدة");
  assert.equal(inventoryProductUnit({ perfumeForm: "decant" }), "piece");
});

test("multiple saved lot prices remain authoritative in each selected warehouse", () => {
  const products = fixture();
  products[3].perfumeLots = [
    { id: "cheap", stocks: { w1: 10, w2: 50 }, liquidUnitCost: 1 },
    { id: "dear", stocks: { w1: 30, w2: 10 }, liquidUnitCost: 3 },
  ];
  const before = structuredClone(products);
  assert.equal(view({ products, categoryId: "system:perfume:decants" }).summary.value, 100);
  assert.equal(view({ products, warehouseIds: ["w1", "w2"], categoryId: "system:perfume:decants" }).summary.value, 180);
  assert.deepEqual(products, before);
});
