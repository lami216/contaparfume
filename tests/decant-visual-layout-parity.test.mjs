import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("specialized sales and purchases use identical regular workspace, table and checkout classes", async () => {
  const [standard, special] = await Promise.all([source("app/conta-app.tsx"), source("app/perfume-invoices.tsx")]);
  const sale = special.slice(special.indexOf("export function DecantSaleInvoice"), special.indexOf("export function DecantBottlePurchaseInvoice"));
  const purchase = special.slice(special.indexOf("export function DecantBottlePurchaseInvoice"));

  for (const [name, block, workspace, payment] of [
    ["sale", sale, "pos-workspace", "pos-payment-row"],
    ["purchase", purchase, "purchase-workspace", "purchase-payment-row"],
  ]) {
    assert.match(block, new RegExp("transaction-workspace " + workspace), name + " workspace");
    assert.match(block, /className="workspace-discovery"/);
    assert.match(block, /className="search-panel"/);
    assert.match(block, /className="invoice-card workspace-invoice"/);
    assert.match(block, /className="invoice-preview has-items"/);
    assert.match(block, /className="erp-table-wrap invoice-preview-list"/);
    assert.match(block, /className="erp-table invoice-table"/);
    assert.match(block, /<colgroup><col style=\{\{width:"38%"\}\}\/\><col style=\{\{width:"14%"\}\}\/\><col style=\{\{width:"17%"\}\}\/\><col style=\{\{width:"19%"\}\}\/\><col style=\{\{width:"12%"\}\}\/\><\/colgroup>/);
    assert.match(block, /className="checkout-layout"/);
    assert.match(block, /className="checkout-footer"/);
    assert.match(block, /className="total invoice-total"/);
    assert.match(block, /className="compact-payment"/);
    assert.match(block, /className="payment-account-select"/);
    assert.ok(block.includes(payment), name + " payment row");
    assert.match(block, /<InvoiceBarcodeScanner/);
  }
  assert.match(standard, /transaction-workspace pos-workspace/);
  assert.match(standard, /transaction-workspace purchase-workspace/);
  assert.match(sale, /className="decant-line-bottle"/);
  assert.doesNotMatch(sale, /<th>\{tr\("زجاجة التقسيمة"\)\}<\/th>/);
  assert.doesNotMatch(purchase, /<th>\{tr\("الحجم"\)\}<\/th>/);
  assert.match(special, /className="quick-invoice-head"/);
  assert.match(special, /className="compact-date-range"/);
  assert.match(special, /className="combobox-trigger"/);
  assert.match(special, /className="pos-quick-customer-button"/);
});

test("management uses form-first workflow, readable reconciliations and full-width stock tables", async () => {
  const [management, css] = await Promise.all([source("app/perfume-divisions.tsx"), source("app/perfume-ui-fixes.css")]);
  const classes = ["perfume-split-card", "perfume-bottles-card", "perfume-batches-card", "perfume-reconciliation-card"];
  const positions = classes.map(item => management.indexOf(`className="perfume-divisions-card ${item}"`));
  assert.ok(positions.every(item => item >= 0));
  assert.deepEqual(positions, [...positions].sort((a,b) => a-b));
  assert.match(management, /className="perfume-split-footer"/);
  assert.match(management, /className="perfume-section-count"/);
  assert.match(css, /grid-template-areas:\s*"split bottles"\s*"batches batches"\s*"reconciliation reconciliation"/);
  assert.match(css, /grid-template-areas:\s*"split"\s*"bottles"\s*"batches"\s*"reconciliation"/);
  assert.match(css, /\.perfume-reconciliation-form \{\s*gap: 10px/);
});
