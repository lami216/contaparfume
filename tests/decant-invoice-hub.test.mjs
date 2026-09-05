import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("decant sale and bottle purchase live in one invoice workspace", async () => {
  const [app, hub, css] = await Promise.all([source("app/conta-app.tsx"), source("app/decant-invoices-page.tsx"), source("app/globals.css")]);
  assert.match(app, /id: "decantInvoices", label: "فواتير التقسيمات"/);
  assert.match(app, /view === "decantInvoices" && <DecantInvoicesPage/);
  assert.doesNotMatch(app, /view === "decantPurchases"/);
  assert.match(hub, /DecantSaleInvoice/);
  assert.match(hub, /DecantBottlePurchaseInvoice/);
  assert.match(hub, /role="tablist"/);
  assert.match(hub, /mode === "sale"/);
  assert.match(hub, /mode === "purchase"/);
  assert.match(css, /\.decant-invoices-hub\s*\{/);
  assert.match(css, /\.decant-invoice-mode-tabs\s*\{/);
});
