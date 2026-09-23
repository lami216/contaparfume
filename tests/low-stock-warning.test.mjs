import test from "node:test";
import assert from "node:assert/strict";
import { clearPersistedSaleDraft, validateSaleDraft } from "../app/sale-draft.ts";
import { finishSuccessfulCommand } from "../app/command-lifecycle.ts";
import { formatLowStockWarning, readPendingLowStockWarning, stagePendingLowStockWarning } from "../app/low-stock-warning.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function installGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
}

function product(stock) {
  return { id: "p1", name: "منتج تجريبي", piecePrice: 10, wholesalePrice: 9, pieceCost: 5, lastPurchaseCost: 5, stocks: { w1: stock } };
}

function line(quantity) {
  return [{ productId: "p1", quantity: String(quantity), piecePrice: "10" }];
}

test("low-stock warning starts only when a successful sale would leave three or fewer", () => {
  const storage = memoryStorage();
  const restoreStorage = installGlobal("sessionStorage", storage);
  try {
    validateSaleDraft(line(1), [product(5)], "w1");
    assert.deepEqual(readPendingLowStockWarning(storage), []);

    validateSaleDraft(line(1), [product(4)], "w1");
    assert.deepEqual(readPendingLowStockWarning(storage), [{ productId: "p1", productName: "منتج تجريبي", remaining: 3 }]);

    validateSaleDraft(line(1), [product(3)], "w1");
    assert.equal(readPendingLowStockWarning(storage)[0].remaining, 2);

    validateSaleDraft(line(3), [product(5)], "w1");
    assert.equal(readPendingLowStockWarning(storage)[0].remaining, 2);

    validateSaleDraft(line(1), [product(1)], "w1");
    assert.equal(readPendingLowStockWarning(storage)[0].remaining, 0);
  } finally { restoreStorage(); }
});

test("invalid sales clear any staged low-stock warning", () => {
  const storage = memoryStorage();
  const restoreStorage = installGlobal("sessionStorage", storage);
  try {
    validateSaleDraft(line(1), [product(4)], "w1");
    assert.equal(readPendingLowStockWarning(storage).length, 1);
    const invalid = validateSaleDraft(line(6), [product(4)], "w1");
    assert.equal(invalid.errors[0].code, "insufficientQuantity");
    assert.deepEqual(readPendingLowStockWarning(storage), []);
  } finally { restoreStorage(); }
});

test("the warning is emitted only after the successful sale reset and includes remaining quantity", async () => {
  const storage = memoryStorage();
  const events = [];
  const restoreStorage = installGlobal("sessionStorage", storage);
  const restoreWindow = installGlobal("window", { dispatchEvent(event) { events.push(event); return true; } });
  const restoreDocument = installGlobal("document", { documentElement: { lang: "ar" } });
  const restoreCustomEvent = installGlobal("CustomEvent", class { constructor(type, init) { this.type = type; this.detail = init?.detail; } });
  try {
    storage.setItem("conta:sale-lines", JSON.stringify(line(1)));
    stagePendingLowStockWarning([{ productId: "p1", productName: "منتج تجريبي", remaining: 3 }], storage);
    await finishSuccessfulCommand(() => clearPersistedSaleDraft(storage), async () => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "alkarna:notice");
    assert.match(events[0].detail, /منتج تجريبي/);
    assert.match(events[0].detail, /3/);

    events.length = 0;
    storage.setItem("conta:sale-lines", JSON.stringify(line(1)));
    stagePendingLowStockWarning([{ productId: "p1", productName: "منتج تجريبي", remaining: 2 }], storage);
    await finishSuccessfulCommand(() => storage.setItem("unrelated", "done"), async () => {});
    assert.equal(events.length, 0);
  } finally {
    restoreCustomEvent();
    restoreDocument();
    restoreWindow();
    restoreStorage();
  }
});

test("warning copy is concise and keeps quantities explicit in Arabic and French", () => {
  const items = [{ productId: "p1", productName: "Sugar", remaining: 2 }];
  assert.equal(formatLowStockWarning("ar", items), "تنبيه: المنتج «Sugar» على وشك النفاد. الكمية المتبقية: 2.");
  assert.match(formatLowStockWarning("fr", items), /Quantité restante : 2/);
});
