import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("perfume management layout keeps dense controls inside their cards", async () => {
  const [layout, safety, divisions] = await Promise.all([
    source("app/layout.tsx"),
    source("app/perfume-layout-safety.css"),
    source("app/perfume-divisions.tsx"),
  ]);

  assert.ok(layout.indexOf('import "./perfume-layout-safety.css"') > layout.indexOf('import "./compact-navigation.css"'));
  assert.match(safety, /grid-template-rows:\s*max-content minmax\(0, 1fr\) auto/);
  assert.match(safety, /"split batches"[\s\S]*"bottles batches"[\s\S]*"error error"/);
  assert.match(safety, /perfume-bottle-adjust[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(safety, /perfume-recombine-control[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(safety, /max-width:\s*1280px[\s\S]*perfume-bottle-create[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(divisions, /perfume-local-error/);
});
