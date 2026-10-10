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

test("management arranges conversion beside batches with full-width reconciliation and bottle stock", async () => {
  const [css, ui] = await Promise.all([
    source("app/perfume-ui-fixes.css"),
    source("app/perfume-divisions.tsx"),
  ]);
  assert.match(css, /Management layout refresh/);
  assert.match(css, /grid-template-areas:\s*"split batches"\s*"reconciliation reconciliation"\s*"bottles bottles"/s);
  assert.match(css, /\.decant-invoices-hub-body\.management \{\s*overflow-x:\s*hidden;\s*overflow-y:\s*auto/s);
  assert.match(css, /\.decant-invoices-hub-body\.management \.perfume-reconciliation-grid \{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /grid-template-areas:\s*"split"\s*"batches"\s*"reconciliation"\s*"bottles"/s);
  assert.match(css, /\.perfume-batches-table \{ min-width: 660px; \}/);
  assert.match(css, /\.perfume-bottles-table \{ min-width: 780px; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.perfume-reconciliation-grid \{\s*grid-template-columns: minmax\(0, 1fr\)/);
  const cardNames = ["perfume-split-card", "perfume-batches-card", "perfume-reconciliation-card", "perfume-bottles-card"];
  const positions = cardNames.map(name => ui.indexOf(`className="perfume-divisions-card ${name}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "keyboard order matches the visible desktop and mobile order");
  assert.doesNotMatch(css, /grid-template-areas:\s*"split reconciliation"\s*"bottles batches"/s);
});


test("special sale and purchase invoices reuse the ordinary quick-browse and new-party controls", async () => {
  const [invoices, hub, app, css] = await Promise.all([
    source("app/perfume-invoices.tsx"), source("app/decant-invoices-page.tsx"),
    source("app/conta-app.tsx"), source("app/perfume-ui-fixes.css"),
  ]);
  assert.match(invoices, /function InvoicePartyPicker/);
  assert.match(invoices, /function QuickInvoiceParty/);
  assert.match(invoices, /type: "party.create", partyType: kind/);
  assert.match(invoices, /canUseCapability\(data\.principal, "customers.create"\)/);
  assert.match(invoices, /canUseCapability\(data\.principal, "suppliers.create"\)/);
  assert.match(invoices, /onDone=\{id => \{ onChange\(id\); setQuick\(false\); \}\}/);
  assert.match(invoices, /filterDocumentsByDate\(documents\.filter\(document => document\.status === "posted"\)/);
  assert.match(invoices, /SortableTableHeader column="number"/);
  assert.match(invoices, /SortableTableHeader column="party"/);
  assert.match(invoices, /SortableTableHeader column="total"/);
  assert.match(invoices, /displayDocumentNumber\(document\)/);
  assert.match(invoices, /event\.stopPropagation\(\); onVoid\(document\)/);
  assert.match(invoices, /printAfterSave && typeof savedId === "string" && savedId\) requestPrint\(savedId\)/);
  assert.match(hub, /requestPrint=\{requestPrint\}/);
  assert.match(app, /<DecantInvoicesPage[^>]*requestPrint=\{setAutoPrintId\}/);
  assert.match(css, /\.decant-history-dates \{/);
  assert.match(css, /\.decant-party-row \{/);
});

test("the special invoice lifecycle retains separate stock commands and does not simulate an edit by replacing an invoice", async () => {
  const invoices = await source("app/perfume-invoices.tsx");
  assert.match(invoices, /type: "decant-sale.post"/);
  assert.match(invoices, /type: "decant-purchase.post"/);
  assert.match(invoices, /type: "decant-sale.void"/);
  assert.match(invoices, /type: "decant-purchase.void"/);
  assert.doesNotMatch(invoices, /type: "sale.post"/);
  assert.doesNotMatch(invoices, /type: "purchase.post"/);
});
