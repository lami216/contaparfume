import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("perfume divisions fit the desktop frame with contained scrolling", async () => {
  const css=`${await readFile(new URL("../app/globals.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/perfume-ui-fixes.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/perfume-layout-safety.css",import.meta.url),"utf8")}`;
  assert.match(css,/\.perfume-divisions-page[\s\S]{0,600}?height:\s*100%[\s\S]{0,300}?overflow:\s*hidden/);
  assert.match(css,/\.perfume-batches-card\s*\{[^}]*overflow:\s*hidden[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(css,/\.perfume-batches-table-wrap\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css,/max-width:\s*1320px[\s\S]*?\.perfume-bottle-create[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
});

test("Arabic and French controls follow locale direction and local access label is translated", async () => {
  const css=`${await readFile(new URL("../app/globals.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/locale-layout.css",import.meta.url),"utf8")}`;
  const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(css,/html\[dir="rtl"\][\s\S]*?\.transaction-workspace > \* \{[\s\S]*?direction:\s*rtl/);
  assert.match(css,/html\[dir="ltr"\][\s\S]*?\.transaction-workspace > \* \{[\s\S]*?direction:\s*ltr/);
  assert.match(css,/\.app-shell[\s\S]*?direction:\s*inherit/);
  assert.match(css,/text-align:\s*start/);
  assert.match(source,/principalType==="local"[\s\S]*?tr\("دخول مباشر"\)/);
});
