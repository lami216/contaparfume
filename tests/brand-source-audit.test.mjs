import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([".git", ".next", "desktop-dist", "dist", "node_modules"]);
const sourceExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yml", ".yaml"]);
const obsoleteName = `الكرن${"ة"}`;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test("visible Arabic brand spelling is authoritative across source, config, and docs", async () => {
  assert.ok(isAbsolute(root), `Repository root must be an absolute filesystem path: ${root}`);
  await assert.doesNotReject(access(join(root, "lib", "app-brand.ts")), `Repository root does not contain lib/app-brand.ts: ${root}`);
  await assert.doesNotReject(access(join(root, "package.json")), `Repository root does not contain package.json: ${root}`);

  // Release-critical scripts must never turn file: URLs into filesystem paths
  // through URL.pathname; fileURLToPath is required for Windows drive letters.
  const releaseScripts = [
    "tests/brand-source-audit.test.mjs",
    "scripts/desktop-prepare.mjs",
    "scripts/prepare-electron-native.mjs",
    "scripts/test-electron-sqlite.cjs",
    "scripts/electron-runtime-probe.cjs",
    "scripts/desktop-test-server.mjs",
    "desktop/main.cjs",
  ];
  for (const script of releaseScripts) {
    const source = await readFile(join(root, script), "utf8");
    assert.doesNotMatch(source, /new URL\([^\n]+\)\.pathname/, `${script} uses URL.pathname as a filesystem path; use fileURLToPath()`);
  }

  const appBrand = await readFile(join(root, "lib", "app-brand.ts"), "utf8");
  assert.match(appBrand, /APP_NAME = "الكرنه"/);
  const offenders = [];
  for (const file of await sourceFiles(root)) {
    if ((await readFile(file, "utf8")).includes(obsoleteName)) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, [], `Obsolete visible brand spelling remains in: ${offenders.join(", ")}`);
});
