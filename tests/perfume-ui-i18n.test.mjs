import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("perfume divisions keep a balanced desktop grid with contained tables and a natural vertical scroll", async () => {
  const [css, safety] = await Promise.all([
    readFile(new URL("../app/perfume-ui-fixes.css", import.meta.url), "utf8"),
    readFile(new URL("../app/perfume-layout-safety.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.decant-invoices-hub-body\.management \{\s*overflow-x: hidden;\s*overflow-y: auto/);
  assert.match(css, /grid-template-areas:\s*"split batches"\s*"reconciliation reconciliation"\s*"bottles bottles"\s*"error error"/s);
  assert.match(css, /\.perfume-batches-table-wrap \{\s*min-height: 230px;\s*max-height: 355px;/);
  assert.match(css, /\.perfume-bottles-table-wrap,[\s\S]*?\.perfume-batches-table-wrap \{[^}]*overflow: auto/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(safety, /\.perfume-divisions-page\s*\{/);
  assert.match(safety, /\.perfume-local-error\s*\{\s*grid-area: error/);
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
