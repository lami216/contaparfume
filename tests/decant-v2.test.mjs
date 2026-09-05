import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("decant v2 has separate bottle inventory and dedicated invoice surfaces", async () => {
  const [logic, invoices, divisions] = await Promise.all([
    source("app/perfume-logic.ts"), source("app/perfume-invoices.tsx"), source("app/perfume-divisions.tsx"),
  ]);
  assert.match(logic, /"bottle"/);
  assert.match(invoices, /DecantSaleInvoice/);
  assert.match(invoices, /DecantBottlePurchaseInvoice/);
  assert.match(invoices, /bottleProductId/);
  assert.match(invoices, /بيع فارغ/);
  assert.doesNotMatch(divisions, /setDecantSizeMl|decantSizeMl\.trim/);
  assert.match(divisions, /perfume-bottle\.create/);
  assert.match(divisions, /إرجاع الباقي إلى عطر ناقص/);
});

test("special commands consume liquid and selected bottles independently", async () => {
  const commands = await source("app/perfume-invoice-commands.ts");
  assert.match(commands, /case "decant-sale\.post"/);
  assert.match(commands, /case "decant-purchase\.post"/);
  assert.match(commands, /case "decant-sale\.void"/);
  assert.match(commands, /case "decant-purchase\.void"/);
  assert.match(commands, /const liquidUnitCost = Number\(lot\.liquidUnitCost/);
  assert.match(commands, /bottleProductId:/);
  assert.match(commands, /"decant-sale-bottle"/);
  assert.match(commands, /perfumeForm: "bottle"/);
});

test("normal sale and purchase exclude decants and bottle stock", async () => {
  const route = await source("app/api/command/route.ts");
  assert.match(route, /handlePerfumeInvoiceCommand/);
  assert.match(route, /\["decant","bottle"\].*فاتورة التقسيمات فقط/);
  assert.match(route, /\["decant","partial","bottle"\].*فاتورة الشراء العادية/);
  const start = route.indexOf('if (type === "perfume-split.post")');
  const end = route.indexOf('if(type==="perfume-recombine.post")', start);
  assert.ok(start >= 0 && end > start);
  const split = route.slice(start, end);
  assert.doesNotMatch(split, /body\.bottleCost|body\.decantSizeMl|divisionLandedCost/);
  assert.match(split, /bottleCost:0/);
  assert.match(split, /landedUnitCost:liquidUnitCost/);
});

test("special commercial documents are sequenced, exposed, reported and translated", async () => {
  const [domain, sequences, bootstrap, reports, app, messages] = await Promise.all([
    source("app/domain.ts"), source("lib/document-sequences.ts"), source("app/api/bootstrap/route.ts"),
    source("lib/reports.ts"), source("app/conta-app.tsx"), source("app/i18n/messages.ts"),
  ]);
  for (const kind of ["decant-sale", "decant-purchase"]) {
    assert.match(domain, new RegExp(kind));
    assert.match(sequences, new RegExp(kind));
    assert.match(bootstrap, new RegExp(kind));
    assert.match(reports, new RegExp(kind));
  }
  assert.match(app, /id: "decantSales", label: "فاتورة التقسيمات"/);
  assert.match(app, /id: "decantPurchases", label: "فاتورة شراء زجاج التقسيمات"/);
  assert.match(messages, /"فاتورة التقسيمات": "Facture de décants"/);
  assert.match(messages, /"فاتورة شراء زجاج التقسيمات": "Achat de flacons pour décants"/);
});

test("only growing decant invoice datasets own scroll areas on desktop", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /\.decant-invoice-page\{[^}]*height:100%[^}]*overflow:hidden/);
  assert.match(css, /\.decant-lines-scroll,[^{]*\.decant-invoice-history-scroll\{[^}]*overflow:auto/);
  assert.match(css, /\.perfume-bottles-table-wrap\{[^}]*overflow:auto/);
});
