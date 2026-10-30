import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production security audit is a blocking Windows build gate", async () => {
  const workflow = await read(".github/workflows/build-windows-desktop.yml");
  assert.match(workflow, /- name: Audit production dependencies\s*\n\s*run: npm audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/, "security audit failures must not be bypassed");
  assert.ok(workflow.indexOf("Audit production dependencies") < workflow.indexOf("npm run desktop:dist:win"));
});

test("Next.js and affected transitive packages are resolved to patched, reproducible versions", async () => {
  const [pkg, lock] = await Promise.all([
    read("package.json").then(JSON.parse),
    read("package-lock.json").then(JSON.parse),
  ]);
  const packages = lock.packages;
  assert.equal(pkg.dependencies.next, "16.4.2");
  assert.equal(pkg.devDependencies["eslint-config-next"], "16.4.2");
  assert.equal(packages["node_modules/next"].version, pkg.dependencies.next);
  assert.equal(packages["node_modules/eslint-config-next"].version, pkg.devDependencies["eslint-config-next"]);
  assert.equal(packages[""].dependencies.next, pkg.dependencies.next);
  for (const [name, secure] of Object.entries({ sharp: "0.35.5", "source-map-js": "1.2.2" })) {
    assert.equal(packages[`node_modules/${name}`].version, secure);
  }
});
