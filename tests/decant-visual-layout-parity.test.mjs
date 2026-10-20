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
    assert.match(block, /"invoice-preview has-items"/);
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

test("management uses the ERP visual system, explicit submit actions and accessible operation tabs", async () => {
  const [management, css] = await Promise.all([source("app/perfume-divisions.tsx"), source("app/perfume-ui-fixes.css")]);
  assert.match(management, /aria-pressed=\{tab===t\}/);
  assert.match(management, /className="pm-form-actions"/);
  assert.match(management, /type="submit"/);
  assert.match(management, /className="erp-table"/);
  assert.match(css, /\.perfume-management-page \.pm-fields[^}]*gap: 10px/);
  assert.match(css, /\.perfume-management-page \.pm-table-scroll th[^}]*position: sticky/);
});

test("specialized sale inherits POS green and purchase inherits ordinary purchase blue at the app-shell level", async () => {
  const [globalCss, perfumeCss, hub] = await Promise.all([
    source("app/globals.css"), source("app/perfume-ui-fixes.css"),
    source("app/decant-invoices-page.tsx"),
  ]);
  assert.match(globalCss, /--color-sales:\s*#087f6f/);
  assert.match(globalCss, /--color-invoices:\s*#2563a9/);
  assert.match(perfumeCss, /\.section-decantInvoices:has\(\.decant-sale-workspace\)\s*\{\s*--section-color:\s*var\(--color-sales/);
  assert.match(perfumeCss, /\.section-decantInvoices:has\(\.decant-purchase-workspace\)\s*\{\s*--section-color:\s*var\(--color-invoices/);
  assert.match(perfumeCss, /\.decant-invoices-hub-body:not\(\.management\)\s*>\s*\.decant-transaction-page\s*\{[\s\S]*?border:\s*2px solid color-mix/);
  assert.match(hub, /<DecantSaleInvoice/);
  assert.match(hub, /<DecantBottlePurchaseInvoice/);
});

test("specialized invoice party searches open above clipped checkout content", async () => {
  const invoices = await source("app/perfume-invoices.tsx");
  const picker = invoices.slice(invoices.indexOf("function InvoicePartyPicker"), invoices.indexOf("function InvoiceHistory"));
  assert.match(picker, /popoverRef/);
  assert.match(picker, /position:\s*"fixed", zIndex:\s*1000/);
  assert.match(picker, /createPortal\(<div ref=\{popoverRef\}/);
  assert.match(picker, /document\.body\)/);
  assert.match(picker, /popoverRef\.current\?\.contains\(target\)/);
});
