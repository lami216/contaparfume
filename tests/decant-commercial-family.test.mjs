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


test("decant sale and bottle purchase always use the default sales warehouse", async () => {
  const [invoices, commands] = await Promise.all([
    source("app/perfume-invoices.tsx"),
    source("app/perfume-invoice-commands.ts"),
  ]);
  assert.match(invoices, /isSalesDefault && warehouse\.isArchived !== true/);
  assert.doesNotMatch(invoices, /setWarehouseId/);
  assert.doesNotMatch(invoices, /tr\("مخزن الاستلام"\)/);
  assert.doesNotMatch(invoices, /type: "decant-sale\.post",\s*warehouseId/s);
  assert.doesNotMatch(invoices, /type: "decant-purchase\.post",\s*warehouseId/s);
  assert.match(commands, /findOne\(\{ isSalesDefault: true, isArchived: \{ \$ne: true \} \}/);
  assert.doesNotMatch(commands, /text\(body\.warehouseId\)/);
  assert.match(commands, /warehouseId: String\(warehouse\._id\)/);
});

test("decant management uses a readable two-by-two desktop layout with natural scrolling", async () => {
  const css = await source("app/perfume-ui-fixes.css");
  assert.match(css, /Management layout refresh/);
  assert.match(css, /grid-template-areas:\s*"split reconciliation"\s*"bottles batches"/s);
  assert.match(css, /decant-invoices-hub-body\.management \{\s*overflow: auto/s);
  assert.match(css, /perfume-reconciliation-grid \{\s*grid-template-columns: 1fr/s);
  assert.match(css, /@media \(max-width: 1050px\)[\s\S]*"split"[\s\S]*"reconciliation"[\s\S]*"bottles"[\s\S]*"batches"/);
});
