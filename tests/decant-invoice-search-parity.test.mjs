import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("decant invoice product searches use the ordinary invoice results table layout", async () => {
  const [search, invoices] = await Promise.all([
    source("app/decant-invoice-product-search.tsx"),
    source("app/perfume-invoices.tsx"),
  ]);
  assert.match(search, /className="product-picker product-search-grid/);
  assert.match(search, /className="erp-table-wrap picker-results"/);
  assert.match(search, /className="erp-table" aria-label=\{tr\("نتائج بحث المنتجات"\)\}/);
  for (const label of ["رقم", "المنتج", "السعر", "المتوفر", "إضافة", "آخر شراء"]) {
    assert.ok(search.includes(`tr("${label}")`), `missing result column ${label}`);
  }
  assert.match(search, /categoryId/);
  assert.match(search, /barcode\.startsWith\(term\)/);
  assert.match(search, /sku\.startsWith\(term\)/);
  assert.match(search, /\.slice\(0, 30\)/);
  assert.match(search, /onSearchKeyDown/);
  assert.match(search, /onPick\(item\.id\)/);
  assert.match(invoices, /<DecantInvoiceProductSearch items=\{pickerItems\} categories=\{data\.categories\} mode="sale" onPick=\{add\}\/>/);
  assert.match(invoices, /<DecantInvoiceProductSearch items=\{pickerItems\} categories=\{data\.categories\} mode="purchase" onPick=\{add\}\/>/);
});

test("the search change preserves dedicated stock flows and the existing management picker", async () => {
  const [invoices, management, commands] = await Promise.all([
    source("app/perfume-invoices.tsx"),
    source("app/perfume-divisions.tsx"),
    source("app/perfume-invoice-commands.ts"),
  ]);
  assert.match(management, /<PerfumeProductPicker items=\{sourceChoices\.map/);
  assert.match(invoices, /type: editingDocument \? "decant-sale.update" : "decant-sale.post"/);
  assert.match(invoices, /type: editingDocument \? "decant-purchase.update" : "decant-purchase.post"/);
  assert.match(invoices, /type: "decant-sale.void"/);
  assert.match(invoices, /type: "decant-purchase.void"/);
  assert.match(invoices, /line\.bottleProductId/);
  assert.match(invoices, /function QuickInvoiceParty/);
  assert.match(invoices, /type: "party.create", partyType: kind/);
  assert.match(commands, /consumeLiquidLots/);
  assert.match(commands, /restoreLiquidAllocations/);
});

test('management integer quantities are valid whole numbers and Escape preserves the selected product',async()=>{
 const ui=await readFile(new URL('../app/perfume-divisions.tsx',import.meta.url),'utf8');
 const picker=await readFile(new URL('../app/perfume-product-picker.tsx',import.meta.url),'utf8');
 assert.match(ui,/options\.integer\?"1":"0\.000001"/);
 assert.match(picker,/event\.key === "Escape"\) \{ event\.preventDefault\(\)/);
 assert.doesNotMatch(picker,/requestAnimationFrame\(\(\) => event\.currentTarget/);
});
