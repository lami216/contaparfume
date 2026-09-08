import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const commandSource = async () => `${await source("app/api/command/route.ts")}\n${await source("app/api/command/base-route.ts")}`;

test("product categories are persisted and exposed through bootstrap", async () => {
  const [domain, bootstrap, command] = await Promise.all([source("app/domain.ts"), source("app/api/bootstrap/route.ts"), commandSource()]);
  assert.match(domain, /interface ProductCategory/);
  assert.match(domain, /categoryId\?: string \| null/);
  assert.match(domain, /categories: ProductCategory\[\]/);
  assert.match(bootstrap, /collection\("productCategories"\)/);
  assert.match(bootstrap, /categories:cleanCategories/);
  assert.match(command, /"product-category\.create"\s*:\s*"products\.create"/);
  assert.match(command, /categoryId: categoryId \|\| null/);
});

test("products can create categories and assign them while creating or editing", async () => {
  const ui = await source("app/conta-app.tsx");
  const dialog = await source("app/product-category-dialog.tsx");
  assert.match(ui, /ProductCategoryDialog/);
  assert.match(ui, /tr\("إضافة فئة"\)/);
  assert.match(ui, /categories=\{data\.categories\}/);
  assert.match(ui, /\[categoryId, setCategoryId\] = useState\(product\?\.categoryId \?\? ""\)/);
  assert.match(ui, /wholesalePrice, categoryId, openingStock/);
  assert.match(dialog, /product-category\.create/);
  assert.match(dialog, /product-category\.update/);
  assert.match(dialog, /product-category\.delete/);
});

test("category report filter sits beside period controls and reaches report backend", async () => {
  const [ui, filters, reports] = await Promise.all([source("app/conta-app.tsx"), source("app/report-types.ts"), source("lib/reports.ts")]);
  assert.match(filters, /categoryId\?: string/);
  assert.match(ui, /add\("categoryId",categoryId\)/);
  assert.match(ui, /className="report-category-filter"/);
  assert.match(ui, /CompactDateRange[\s\S]*report-category-filter[\s\S]*report-print-button/);
  assert.match(reports, /categoryId: text\(url\.searchParams\.get\("categoryId"\)\)/);
  assert.match(reports, /find\(\{ categoryId: f\.categoryId \}\)/);
  assert.match(reports, /categoryScope/);
});
