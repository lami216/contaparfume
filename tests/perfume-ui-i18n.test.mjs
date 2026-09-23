import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("perfume divisions fit the desktop frame and only the batch list scrolls", async () => {
  const css=`${await readFile(new URL("../app/globals.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/perfume-ui-fixes.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/perfume-layout-safety.css",import.meta.url),"utf8")}`;
  const page=css.match(/\.perfume-divisions-page\s*\{([^}]*)\}/)?.[1]??"";
  const batches=css.match(/\.perfume-batches-card\s*\{([^}]*)\}/)?.[1]??"";
  const table=css.match(/\.perfume-batches-table-wrap\s*\{([^}]*)\}/)?.[1]??"";
  assert.match(page,/grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(page,/height:100%/);
  assert.match(page,/overflow:hidden/);
  assert.doesNotMatch(page,/overflow-y:auto/);
  assert.match(batches,/grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(batches,/overflow:hidden/);
  assert.match(table,/height:100%/);
  assert.match(table,/overflow:auto/);
});

test("Arabic and French controls follow locale direction and local access label is translated", async () => {
  const css=`${await readFile(new URL("../app/globals.css",import.meta.url),"utf8")}\n${await readFile(new URL("../app/locale-layout.css",import.meta.url),"utf8")}`;
  const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(css,/html\[dir="rtl"\][\s\S]*?\.transaction-workspace > \* \{[\s\S]*?direction:\s*rtl/);
  assert.match(css,/html\[dir="ltr"\][\s\S]*?\.transaction-workspace > \* \{[\s\S]*?direction:\s*ltr/);
  assert.match(css,/\.app-shell[\s\S]*?direction:\s*inherit/);
  assert.match(css,/text-align:\s*start/);
  assert.match(source,/principalType==="local"\?tr\("دخول مباشر"\):data\.principal\.name/);
});
