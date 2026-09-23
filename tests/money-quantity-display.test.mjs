import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatMoney, formatQuantity } from "../app/domain.ts";

const source = await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8");
const openingHistorySource = await readFile(new URL("../app/opening-stock-history.tsx", import.meta.url), "utf8");

test("money carries MRU while quantities remain unitless", () => {
  assert.equal(formatMoney(7), "7 MRU");
  assert.equal(formatQuantity(7), "7");
});

test("warehouse movement report uses declared column types instead of key-name currency guesses", () => {
  assert.match(source, /\["before",tr\("قبل"\),"number"\]/);
  assert.match(source, /\["change",tr\("التغيير"\),"number"\]/);
  assert.match(source, /\["after",tr\("بعد"\),"number"\]/);
  assert.doesNotMatch(source, /const monetaryKeys=/);
  assert.doesNotMatch(source, /const numericKeys=/);
  assert.match(source, /columnType==="money"\?<MoneyValue/);
  assert.match(source, /columnType==="number"\|\|columnType==="money"/);
});

test("displayed prices, totals, and inventory values use currency formatting", () => {
  const forbidden = [
    /number\(inventoryValue\)/,
    /number\(inventoryUnitCost\(/,
    /number\(selectedQty \* inventoryUnitCost\(/,
    /number\(qty\(product\) \* inventoryUnitCost\(/,
    /number\(lineTotal\)/,
    /number\(document\.total\)/,
    /number\(d\.total\)/,
    /number\(product\.piecePrice\)/,
    /number\(product\.wholesalePrice\)/,
    /number\(product\.lastPurchaseCost\)/,
    /number\(product\.pieceCost\)/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
  assert.match(source, /hasInventoryView\?money\(inventoryValue\)/);
  assert.match(source, /money\(inventoryUnitCost\(product\)\)/);
  assert.match(source, /money\(selectedQty \* inventoryUnitCost\(product\)\)/);
  assert.match(source, /<MoneyValue value=\{lineTotal\}\/>/);
  assert.match(source, /<MoneyValue value=\{document\.total\}\/>/);
});

test("stock counts and quantities stay plain numbers without MRU", () => {
  assert.match(source, /number\(totalPieces\)/);
  assert.match(source, /number\(qty\(product\)\)/);
  assert.match(source, /number\(selectedQty\)/);
  assert.match(openingHistorySource, /number\(delta\)/);
  assert.doesNotMatch(openingHistorySource, /money\(delta\)/);
  assert.doesNotMatch(source, /money\(totalPieces\)|money\(qty\(product\)\)|money\(selectedQty\)|money\(current\)|money\(stock\)/);
});
