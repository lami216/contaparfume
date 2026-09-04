import {access, cp, lstat, mkdir, readdir, readlink, realpath, rm, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";

const repositoryRoot = await realpath(process.cwd());
const output = path.join(repositoryRoot, "desktop-dist", "app");

await rm(path.dirname(output), {recursive: true, force: true});
await mkdir(output, {recursive: true});
await cp(path.join(repositoryRoot, ".next", "standalone"), output, {recursive: true});
await mkdir(path.join(output, ".next"), {recursive: true});
await cp(path.join(repositoryRoot, ".next", "static"), path.join(output, ".next", "static"), {recursive: true});
await cp(path.join(repositoryRoot, "public"), path.join(output, "public"), {recursive: true});
await cp(
  path.join(repositoryRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  path.join(output, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
);

const requiredPaths = [
  "server.js",
  "node_modules/better-sqlite3",
  "node_modules/sql.js",
  "node_modules/sql.js/dist/sql-wasm.wasm",
];
for (const required of requiredPaths) {
  try { await access(path.join(output, required)); }
  catch { throw new Error(`Desktop staging is incomplete; required path is missing: ${required}`); }
}

const insideOutput = (candidate) => {
  const relative = path.relative(output, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

// Turbopack emits hashed external-package aliases below .next/node_modules. On
// Windows they are junctions and fs.cp preserves their absolute build-tree
// targets; on POSIX fs.cp turns the relative links into absolute links too.
// Replace those aliases with relocatable shims to the one canonical staged copy.
const aliases = ["better-sqlite3", "sql.js"];
const aliasRoot = path.join(output, ".next", "node_modules");
try { await access(aliasRoot); }
catch { throw new Error(`Next standalone traced-alias directory is missing: ${aliasRoot}`); }
const replaced = new Set();
for (const entry of await readdir(aliasRoot)) {
  const packageName = aliases.find((name) => entry.startsWith(`${name}-`));
  if (!packageName) continue;
  const aliasPath = path.join(aliasRoot, entry);
  if (!insideOutput(aliasPath)) throw new Error(`Refusing to create an alias outside the staged app: ${aliasPath}`);
  const stat = await lstat(aliasPath);
  if (stat.isSymbolicLink()) console.log(`Replacing traced external link ${entry} -> ${await readlink(aliasPath)}`);
  await rm(aliasPath, {recursive: true, force: true});
  await mkdir(aliasPath, {recursive: true});
  await writeFile(path.join(aliasPath, "package.json"), JSON.stringify({private: true, main: "index.cjs"}));
  await writeFile(path.join(aliasPath, "index.cjs"), `module.exports = require(${JSON.stringify(`../../../node_modules/${packageName}`)});\n`);
  const aliasRequire = createRequire(path.join(aliasPath, "index.cjs"));
  const shimSpecifier = `../../../node_modules/${packageName}`;
  const resolved = await realpath(aliasRequire.resolve(shimSpecifier));
  const canonical = await realpath(createRequire(path.join(output, "server.js")).resolve(packageName));
  if (resolved !== canonical) throw new Error(`Traced alias ${entry} resolves to ${resolved}, expected ${canonical}`);
  if (!insideOutput(resolved)) throw new Error(`Traced alias ${entry} escapes the staged app: ${resolved}`);
  replaced.add(packageName);
}
for (const packageName of aliases) {
  if (!replaced.has(packageName)) throw new Error(`Next standalone output has no traced ${packageName} alias below ${aliasRoot}`);
}

for (const relative of [
  "node_modules/better-sqlite3",
  "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
]) {
  const physical = await realpath(path.join(output, relative));
  if (!insideOutput(physical)) {
    throw new Error(`Staged runtime path escapes the app: ${relative} -> ${physical}`);
  }
  console.log(`Staged physical path: ${physical}`);
}
