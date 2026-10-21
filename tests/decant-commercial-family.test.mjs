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
  assert.match(invoices, /transaction-workspace pos-workspace decant-sale-workspace/);
  assert.match(invoices, /transaction-workspace purchase-workspace decant-purchase-workspace/);
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


test("new decant invoices use the default sales warehouse and edits preserve the original", async () => {
  const [invoices, commands] = await Promise.all([
    source("app/perfume-invoices.tsx"),
    source("app/perfume-invoice-commands.ts"),
  ]);
  assert.match(invoices, /isSalesDefault && warehouse\.isArchived !== true/);
  assert.doesNotMatch(invoices, /setWarehouseId/);
  assert.match(invoices, /className="decant-fixed-warehouse"/); // The warehouse is visible but read-only; the command still uses the default.
  assert.doesNotMatch(invoices, /type: "decant-sale\.post",\s*warehouseId/s);
  assert.doesNotMatch(invoices, /type: "decant-purchase\.post",\s*warehouseId/s);
  assert.match(commands, /findOne\(\{ isSalesDefault: true, isArchived: \{ \$ne: true \} \}/);
  assert.doesNotMatch(commands, /text\(body\.warehouseId\)/);
  assert.match(commands, /warehouseId: String\(warehouse\._id\)/);
  assert.match(commands, /existing\s*\? warehouses\(db\)\.findOne\(\{ _id: String\(existing\.warehouseId\) \}/);
});

test("management separates tasks and keeps forms before their scrollable registers", async () => {
  const [css, ui] = await Promise.all([source("app/perfume-ui-fixes.css"), source("app/perfume-divisions.tsx")]);
  assert.match(ui, /"convert","stock","bottles","history"/);
  assert.match(ui, /className="erp-fieldset popover-host pm-editor"/);
  assert.match(ui, /className="erp-fieldset pm-register"/);
  assert.ok(ui.indexOf('className="erp-fieldset popover-host pm-editor"') < ui.indexOf('className="erp-fieldset pm-register"'));
  assert.match(css, /\.perfume-management-page \.pm-workspace[^}]*grid-template-columns/);
  assert.match(css, /\.perfume-management-page \.pm-table-scroll[^}]*overflow: auto/);
  assert.match(css, /@media \(max-width: 1050px\)[^}]*grid-template-columns: minmax\(0,1fr\)/);
  assert.match(ui, /canManage/);
});


test("special sale and purchase invoices reuse the ordinary quick-browse and new-party controls", async () => {
  const [invoices, hub, app] = await Promise.all([
    source("app/perfume-invoices.tsx"), source("app/decant-invoices-page.tsx"),
    source("app/conta-app.tsx"),
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
  assert.match(invoices, /canManage \? onEdit\(document\) : openDoc\(document\.id\)/);
  assert.match(invoices, /printAfterSave && typeof savedId === "string" && savedId\) requestPrint\(savedId\)/);
  assert.match(hub, /requestPrint=\{requestPrint\}/);
  assert.match(app, /<DecantInvoicesPage[^>]*requestPrint=\{setAutoPrintId\}/);
  assert.match(invoices, /className="compact-date-range"/);
  assert.match(invoices, /combobox-pos-customer/);
  assert.match(invoices, /className="pos-quick-customer-button"/);
});

test("special invoice lifecycle uses atomic in-place amendments, not a new unrelated invoice", async () => {
  const invoices = await source("app/perfume-invoices.tsx");
  assert.match(invoices, /type: editingDocument \? "decant-sale.update" : "decant-sale.post"/);
  assert.match(invoices, /type: editingDocument \? "decant-purchase.update" : "decant-purchase.post"/);
  assert.match(invoices, /type: "decant-sale.void"/);
  assert.match(invoices, /type: "decant-purchase.void"/);
  assert.doesNotMatch(invoices, /type: "sale.post"/);
  assert.doesNotMatch(invoices, /type: "purchase.post"/);
});


test("regular and specialized invoices keep separate session drafts", async () => {
  const [normal, specialized] = await Promise.all([
    source("app/conta-app.tsx"), source("app/perfume-invoices.tsx"),
  ]);
  assert.match(normal, /useSessionDraft<DraftLine\[\]>\("sale-lines"/);
  assert.match(normal, /useSessionDraft<DraftLine\[\]>\("purchase-lines"/);
  assert.match(specialized, /useDecantSessionDraft<DraftLine\[\]>\("sale-lines", \[\]\)/);
  assert.match(specialized, /useDecantSessionDraft<DraftLine\[\]>\("purchase-lines", \[\]\)/);
  assert.match(specialized, /const storageKey = `conta:decant-\$\{key\}`/);
  assert.match(specialized, /sessionStorage\.setItem\(storageKey, JSON\.stringify\(value\)\)/);
  assert.doesNotMatch(specialized, /const \[lines, setLines\] = useState<DraftLine\[\]>\(\[\]\)/);
});
