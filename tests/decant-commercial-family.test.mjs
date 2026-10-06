import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("decant documents keep specialized kinds but have normal commercial families", async () => {
  const domain = await source("app/domain.ts");
  assert.match(domain, /commercialDocumentFamily/);
  assert.match(domain, /kind === "sale" \|\| kind === "decant-sale"/);
  assert.match(domain, /kind === "purchase" \|\| kind === "decant-purchase"/);
});

test("overview groups decant invoices with normal sales and purchases", async () => {
  const app = await source("app/conta-app.tsx");
  assert.match(app, /invoiceFamilies/);
  assert.match(app, /label: tr\("فواتير البيع"\).*commercialDocumentFamily/s);
  assert.match(app, /label: tr\("فواتير الشراء"\).*commercialDocumentFamily/s);
  assert.doesNotMatch(app, /\["sale","decant-sale","purchase","decant-purchase","expense"\]/);
});

test("decant invoices reuse standard transaction workspace without entering POS history", async () => {
  const [app, invoices] = await Promise.all([
    source("app/conta-app.tsx"),
    source("app/perfume-invoices.tsx"),
  ]);
  assert.match(invoices, /transaction-workspace decant-sale-workspace/);
  assert.match(invoices, /transaction-workspace decant-purchase-workspace/);
  assert.match(invoices, /workspace-discovery/);
  assert.match(invoices, /workspace-invoice/);
  assert.match(invoices, /workspace-checkout/);
  assert.match(invoices, /document\.kind === "decant-sale"/);
  assert.match(invoices, /document\.kind === "decant-purchase"/);
  assert.match(app, /docs=\{data\.documents\.filter\(d => d\.kind === "sale" && d\.status === "posted"\)\}/);
  assert.match(app, /docs=\{data\.documents\.filter\(d => d\.kind === "purchase" && d\.status === "posted"\)\}/);
});

test("decant invoices follow the same all-paid-or-note settlement rule", async () => {
  const commands = await source("app/perfume-invoice-commands.ts");
  const matches = commands.match(/الدفع الجزئي داخل الفاتورة غير مدعوم/g) ?? [];
  assert.equal(matches.length, 2);
  assert.match(commands, /paymentMethod === "note" \? doc\.total : 0/);
  assert.match(commands, /partyDelta = dueTotal/);
  assert.match(commands, /partyDelta = -dueTotal/);
});
