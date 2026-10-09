import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("last-loaded perfume guardrails cannot override the management grid", async () => {
  const [layout, safety, css, divisions] = await Promise.all([
    source("app/layout.tsx"),
    source("app/perfume-layout-safety.css"),
    source("app/perfume-ui-fixes.css"),
    source("app/perfume-divisions.tsx"),
  ]);

  assert.ok(layout.indexOf('import "./perfume-layout-safety.css"') > layout.indexOf('import "./perfume-ui-fixes.css"'));
  assert.doesNotMatch(safety, /\.perfume-divisions-page\s*\{/);
  assert.doesNotMatch(safety, /\.perfume-batches-card\s*\{/);
  assert.match(css, /"split batches"\s*"reconciliation reconciliation"\s*"bottles bottles"\s*"error error"/s);
  assert.match(safety, /\.perfume-bottle-adjust\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(safety, /\.perfume-local-error\s*\{\s*grid-area:\s*error/);
  assert.match(css, /\.perfume-bottles-card\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
  assert.match(divisions, /perfume-local-error/);
});
