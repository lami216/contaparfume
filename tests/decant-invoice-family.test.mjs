import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { calculatePartyFinancialSummaries } from "../app/party-metrics.ts";
import { resolveProductCost } from "../lib/product-cost.ts";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("decant invoices share sale and purchase families without joining quick browsers", async () => {
  const [family, readModel, reports, bootstrap, app] = await Promise.all([
    source("lib/document-family.ts"),
    source("lib/document-read-model.ts"),
    source("lib/reports.ts"),
    source("app/api/bootstrap/route.ts"),
    source("app/conta-app.tsx"),
  ]);

  assert.match(family, /SALE_DOCUMENT_KINDS = \["sale", "decant-sale"\]/);
  assert.match(family, /PURCHASE_DOCUMENT_KINDS = \["purchase", "decant-purchase"\]/);
  assert.match(readModel, /documentFamily\(kind\)/);
  assert.match(reports, /SALE_DOCUMENT_KINDS/);
  assert.match(reports, /PURCHASE_DOCUMENT_KINDS/);
  assert.doesNotMatch(bootstrap, /perfumeAccess&&\["decant-sale","decant-purchase"\]/);

  assert.match(app, /matches: \(kind: string\) => documentFamily\(kind\) === "sale"/);
  assert.match(app, /matches: \(kind: string\) => documentFamily\(kind\) === "purchase"/);
  assert.match(app, /data\.documents\.filter\(d => d\.kind === "sale" && d\.status === "posted"\)/);
  assert.match(app, /data\.documents\.filter\(d => d\.kind === "purchase" && d\.status === "posted"\)/);
});

test("decant invoice posting follows normal settlement rules while void stays perfume-aware", async () => {
  const commands = await source("app/perfume-invoice-commands.ts");
  const paymentRule = "الدفع الجزئي داخل الفاتورة غير مدعوم";
  assert.equal(commands.split(paymentRule).length - 1, 2);
  assert.match(commands, /paymentMethod === "note" \? 0 : doc\.total/);
  assert.match(commands, /restoreLiquidAllocations/);
  assert.match(commands, /"decant-sale-void-bottle"/);
  assert.match(commands, /"decant-purchase-void"/);
});

test("decant invoice screens present as sale and purchase invoices but keep dedicated history", async () => {
  const invoices = await source("app/perfume-invoices.tsx");
  assert.match(invoices, /tr\("فاتورة بيع"\).*tr\("فاتورة التقسيمات"\)/);
  assert.match(invoices, /tr\("فاتورة شراء"\).*tr\("فاتورة شراء زجاج التقسيمات"\)/);
  assert.match(invoices, /title="فواتير البيع"/);
  assert.match(invoices, /title="فواتير الشراء"/);
  assert.match(invoices, /document\.kind === "decant-sale"/);
  assert.match(invoices, /document\.kind === "decant-purchase"/);
});


test("decant invoices contribute to party trade metrics as normal commercial invoices", () => {
  const summaries = calculatePartyFinancialSummaries([
    { kind: "decant-sale", status: "posted", partyId: "customer", total: 1200, lines: [{ grossProfit: 300 }] },
    { kind: "decant-purchase", status: "posted", partyId: "supplier", total: 400, lines: [] },
  ], []);
  const customer = summaries.find(row => row.partyId === "customer");
  const supplier = summaries.find(row => row.partyId === "supplier");
  assert.equal(customer.customerTradeTotal, 1200);
  assert.equal(customer.customerGrossProfit, 300);
  assert.equal(supplier.supplierTradeTotal, 400);
  assert.equal(supplier.supplierInvoiceCount, 1);
});

test("decant bottle purchases are valid purchase-cost authority", () => {
  const result = resolveProductCost(
    { id: "bottle-1" },
    [{
      kind: "decant-purchase",
      status: "posted",
      occurredAt: "2026-10-05T12:00:00.000Z",
      sequence: 3,
      lines: [{ productId: "bottle-1", unitPrice: 18 }],
    }],
  );
  assert.equal(result.cost, 18);
  assert.equal(result.source, "purchase");
});
