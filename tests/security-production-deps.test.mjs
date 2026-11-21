import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("full dependency security audit is a blocking Windows build gate, including packaged Electron", async () => {
  const workflow = await read(".github/workflows/build-windows-desktop.yml");
  assert.match(workflow, /- name: Audit locked runtime and build dependencies\s*\n\s*run: npm audit --audit-level=moderate/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/, "security audit failures must not be bypassed");
  assert.ok(workflow.indexOf("Audit locked runtime and build dependencies") < workflow.indexOf("npm run desktop:dist:win"));
});

test("Next.js and affected transitive packages are resolved to patched, reproducible versions", async () => {
  const [pkg, lock] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
  ]);
  const packages = lock.packages;
  assert.equal(pkg.dependencies.next, "16.4.6");
  assert.equal(pkg.devDependencies["eslint-config-next"], "16.4.6");
  assert.equal(packages["node_modules/next"].version, pkg.dependencies.next);
  assert.equal(packages["node_modules/eslint-config-next"].version, pkg.devDependencies["eslint-config-next"]);
  assert.equal(packages[""].dependencies.next, pkg.dependencies.next);
  assert.equal(pkg.devDependencies.electron, "44.9.1");
  assert.equal(packages[""].devDependencies.electron, pkg.devDependencies.electron);
  for (const [name, secure] of Object.entries({
    electron: "44.9.1", undici: "7.30.1", "follow-redirects": "1.16.2",
    "fast-uri": "3.1.9", "shell-quote": "1.11.0", zod: "4.6.6", joi: "17.13.9",
  })) assert.equal(packages[`node_modules/${name}`].version, secure, name);
  assert.equal(packages["node_modules/node-gyp/node_modules/undici"].version, "6.29.1");
  for (const [path, entry] of Object.entries(packages)) {
    if (/(?:^|\/)node_modules\/minimatch$/.test(path) && Number(entry.version.split(".")[0]) >= 7) {
      assert.equal(entry.version, "11.0.1", path);
    }
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (path.startsWith("node_modules/@next/")) assert.equal(entry.version, pkg.dependencies.next, path);
  }
  for (const [name, secure] of Object.entries({ sharp: "0.35.5", "source-map-js": "1.2.2" })) {
    assert.equal(packages[`node_modules/${name}`].version, secure);
  }
});
