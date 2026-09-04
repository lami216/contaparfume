import assert from "node:assert/strict";
import test from "node:test";
import { applyPriceMode, formatSaleValidationError, sellingPrice, updateSaleDraftLine, validateSaleDraft } from "../app/sale-draft.ts";

const product = { id: "lion", name: "أسد زيريار", sku: "1", barcode: "", pieceCost: 12000, lastPurchaseCost: 12000, piecePrice: 7500, stocks: { sales: 5 } };
const draft = (quantity = "1", piecePrice = "7500") => ({ productId: product.id, quantity, piecePrice, unitPrice: "", actualQuantity: "" });

test("sale draft accepts empty and every intermediate price without onChange validation", () => {
  let lines = [draft()];
  for (const piecePrice of ["", "3", "30", "300", "3000", "30000"]) {
    lines = updateSaleDraftLine(lines, product.id, { piecePrice });
    assert.equal(lines[0].piecePrice, piecePrice);
  }
  assert.deepEqual(validateSaleDraft(lines, [product], "sales").errors, []);
});

test("submit validation preserves below-cost price and over-stock quantity in the draft", () => {
  const belowCost = [draft("4", "10000")];
  const result = validateSaleDraft(belowCost, [product], "sales");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [{ productId: product.id, productName: product.name, salePrice: 10000, purchaseCost: 12000 }]);
  assert.equal(belowCost[0].piecePrice, "10000");

  const overStock = [draft("10", "30000")];
  assert.match(validateSaleDraft(overStock, [product], "sales").errors.map(error => formatSaleValidationError("ar", error)).join(" "), /هي 10 والمتوفر 5 فقط/);
  assert.equal(overStock[0].quantity, "10");
  assert.deepEqual(validateSaleDraft([draft("4", "30000")], [product], "sales").errors, []);
});

test("submit validation rejects temporarily empty quantity and price", () => {
  const result = validateSaleDraft([draft("", "")], [product], "sales");
  assert.equal(result.errors.length, 2);
});

test("retail and wholesale tiers select safe editable draft defaults", () => {
  const tiered = { ...product, piecePrice: 1000, wholesalePrice: 800 };
  assert.equal(sellingPrice(tiered), 1000);
  assert.equal(sellingPrice(tiered, "wholesale"), 800);
  assert.equal(sellingPrice({ ...tiered, wholesalePrice: null }, "wholesale"), 1000);
  const switched = applyPriceMode([{ ...draft(), piecePrice: "777" }], [tiered], "wholesale");
  assert.equal(switched[0].piecePrice, "800");
  assert.equal(updateSaleDraftLine(switched, product.id, { piecePrice: "850" })[0].piecePrice, "850");
});

import { clearPersistedSaleDraft, initialSaleUiState } from "../app/sale-draft.ts";
import { finishSuccessfulCommand } from "../app/command-lifecycle.ts";

const memoryStorage = initial => {
  const values = new Map(Object.entries(initial));
  return { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), values };
};

for (const payment of ["cash", "note"]) test(`successful ${payment} sale clears persisted draft before silent refresh`, async () => {
  const storage = memoryStorage({ "conta:sale-lines": JSON.stringify([draft(), { ...draft(), productId: "b" }]), "conta:sale-payment": JSON.stringify(payment), "conta:sale-party": JSON.stringify(payment === "note" ? "party-1" : "") });
  const order = [];
  await finishSuccessfulCommand(() => { clearPersistedSaleDraft(storage); order.push("clear"); }, async () => { order.push("refresh"); assert.equal(storage.getItem("conta:sale-lines"), "[]"); });
  assert.deepEqual(order, ["clear", "refresh"]);
  assert.equal(storage.getItem("conta:sale-payment"), '""');
  assert.equal(storage.getItem("conta:sale-party"), '""');
});

test("failed sale preserves the entire draft because success completion is not run", async () => {
  const original = JSON.stringify([draft(), { ...draft(), productId: "b" }]);
  const storage = memoryStorage({ "conta:sale-lines": original });
  await assert.rejects(async () => { throw new Error("sale.post failed"); });
  assert.equal(storage.getItem("conta:sale-lines"), original);
});

test("sale UI defaults and successful reset are retail with scanner off", () => {
  assert.deepEqual(initialSaleUiState, { priceMode: "retail", scannerEnabled: false });
  let state = { priceMode: "wholesale", scannerEnabled: true };
  state = { ...initialSaleUiState };
  assert.deepEqual(state, { priceMode: "retail", scannerEnabled: false });
});

import { isProductExpired } from "../app/domain.ts";

test("expiry is inclusive and frontend draft validation blocks only later dates", () => {
  const expiring = { ...product, lastPurchaseCost: null, expiryDate: "2026-08-22" };
  assert.equal(isProductExpired(expiring, "2026-08-22"), false);
  assert.equal(validateSaleDraft([draft()], [expiring], "sales", "2026-08-22").errors.length, 0);
  assert.equal(isProductExpired(expiring, "2026-08-23"), true);
  assert.match(validateSaleDraft([draft()], [expiring], "sales", "2026-08-23").errors.map(error => formatSaleValidationError("ar", error)).join(" "), /انتهت صلاحية/);
});
