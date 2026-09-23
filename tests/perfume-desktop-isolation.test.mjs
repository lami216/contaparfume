import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("perfume desktop installation is isolated from the accounting desktop app", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");

  assert.equal(pkg.name, "alkarna-perfume-desktop");
  assert.equal(pkg.build.appId, "mr.alkarna.perfume.desktop");
  assert.equal(pkg.build.executableName, "AlKarnaPerfume");
  assert.equal(pkg.build.nsis.shortcutName, "الكرنة للعطور");
  assert.equal(pkg.build.nsis.artifactName, "AlKarna-Perfume-Setup-x64.exe");
  assert.equal(pkg.build.nsis.uninstallDisplayName, "الكرنة للعطور");
  assert.equal(pkg.build.nsis.guid, "f49df4d4-747b-4ed4-b7d4-3cb1635b6485");

  assert.match(main, /const APP_ID='mr\.alkarna\.perfume\.desktop'/);
  assert.match(main, /const USER_DATA_DIR='AlKarna-Perfume'/);
  assert.match(main, /app\.setPath\('userData',isolatedUserData\)/);
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/);
  assert.match(main, /alkarna-perfume\.sqlite/);
  assert.match(main, /AlKarna-Perfume-Licensing/);
  assert.match(main, /ALKARNA_LICENSE_DISABLE_REGISTRY:'1'/);
});
