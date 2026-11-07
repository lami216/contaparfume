import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("product hover text uses the original name, not a shortened or transformed copy", async () => {
  const [component, css] = await Promise.all([
    source("app/product-name.tsx"), source("app/globals.css"),
  ]);
  assert.match(component, /title=\{name\}/);
  assert.match(component, />\{name\}<\/span>/);
  assert.match(css, /\.product-name-hover\s*\{[^}]*max-width:\s*100%[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(css, /@media print\s*\{\s*\.product-name-hover\s*\{[^}]*overflow:\s*visible[^}]*white-space:\s*normal/s);
});

test("sales and purchases reveal full names both in product search and draft rows", async () => {
  const app = await source("app/conta-app.tsx");
  assert.match(app, /import ProductName from "\.\/product-name"/);
  assert.match(app, /product-result-\$\{product\.id\}[\s\S]*?<td className="name-cell"><ProductName name=\{product\.name\}\/>/);
  assert.match(app, /selectedLine === p\.id[\s\S]*?<td className="name-cell"><ProductName name=\{p\.name\}\/>/);
  assert.match(app, /selectedLine === product\.id[\s\S]*?<td className="name-cell"><ProductName name=\{product\.name\}\/>/);
});

test("long product names are recoverable across the product catalog, warehouses and stock corrections", async () => {
  const [app, opening] = await Promise.all([
    source("app/conta-app.tsx"), source("app/opening-stock-history.tsx"),
  ]);
  assert.match(app, /inventory-grid[\s\S]*?<ProductName name=\{product\.name\}\/>/);
  assert.match(app, /<td className="name-cell"><ProductName name=\{product\.name\}\/>\{product\.isArchived&&/);
  assert.match(app, /<ProductName name=\{product\?\.name\?\?line\.productId\}\/>/);
  assert.match(app, /movement-product-head[\s\S]*?<ProductName name=\{product\.name\}\/>/);
  assert.match(app, /field\(tr\("اسم المنتج"\),<ProductName name=\{product\.name\}\/>\)/);
  assert.match(opening, /<td className="name-cell" title=\{productNames\}>\{productNames\}<\/td>/);
});

test("product report filters, results, movement history and invoice previews provide full hover labels", async () => {
  const app = await source("app/conta-app.tsx");
  assert.match(app, /onPointerDown=\{event => \{ event\.preventDefault\(\); choose\(option\.value\); \}\} title=\{option\.label\}/);
  assert.match(app, /title=\{options\.find\(x => x\.value === value\)\?\.label \?\? undefined\}/);
  assert.match(app, /title=\{row\.productName\}>\{row\.productName\}/);
  assert.match(app, /key==="number"\|\|key==="product"\?String\(row\[key\]\?\?""\):undefined/);
  assert.match(app, /presentation\.columns\?\.\[j\]===tr\("المنتج"\)&&typeof v==="string"\?v:undefined/);
});
test("hovered product names follow RTL table alignment in Arabic without changing truncation", async () => {
  const css = await source("app/globals.css");
  assert.match(css, /html\[dir="rtl"\] \.name-cell:has\(> \.product-name-hover\) \{\s*direction: rtl;\s*unicode-bidi: normal;\s*\}/);
});
