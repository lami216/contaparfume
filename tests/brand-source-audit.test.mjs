import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("perfume edition brand and Windows identity stay isolated from the original AlKarna app", async () => {
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
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const desktop = await readFile(join(root, "desktop", "main.cjs"), "utf8");

  assert.match(appBrand, /APP_NAME = "الكرنة"/);
  assert.match(appBrand, /APP_TAGLINE = "العطور"/);
  assert.equal(packageJson.displayName, "الكرنة للعطور");
  assert.equal(packageJson.build.appId, "mr.alkarna.perfume.desktop");
  assert.equal(packageJson.build.productName, "الكرنة للعطور");
  assert.equal(packageJson.build.nsis.shortcutName, "الكرنة للعطور");
  assert.equal(packageJson.build.nsis.artifactName, "AlKarna-Perfume-Setup-x64.exe");

  assert.match(desktop, /PRODUCT_NAME='الكرنة للعطور'/);
  assert.match(desktop, /APP_ID='mr\.alkarna\.perfume\.desktop'/);
  assert.match(desktop, /USER_DATA_DIR='AlKarna-Perfume'/);
  assert.match(desktop, /app\.setPath\('userData',isolatedUserData\)/);
  assert.match(desktop, /ALKARNA_DATABASE_PATH:join\(userData,'data','alkarna-perfume\.sqlite'\)/);
  assert.match(desktop, /AlKarna-Perfume-Licensing/);
  assert.match(desktop, /ALKARNA_LICENSE_DISABLE_REGISTRY:'1'/);
});
