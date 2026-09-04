/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads hooks as CommonJS. */
const {createHash} = require('node:crypto');
const {cp, lstat, mkdir, readFile, realpath, rm} = require('node:fs/promises');
const {join} = require('node:path');
const {isPathInside} = require('./path-containment.cjs');

const RUNTIME_DIRECTORY = 'alkarna-runtime';
const requiredFiles = [
  'server.js',
  'public/alkarna-logo.png',
  'node_modules/better-sqlite3/package.json',
  'node_modules/better-sqlite3/lib/index.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/sql.js/package.json',
  'node_modules/sql.js/dist/sql-wasm.js',
  'node_modules/sql.js/dist/sql-wasm.wasm',
];
const requiredDirectories = ['.next', '.next/static', 'public'];
const criticalFiles = [
  'server.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/sql.js/dist/sql-wasm.wasm',
];

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function verifyContents(root, label) {
  for (const file of requiredFiles) {
    if (!(await lstat(join(root, file))).isFile()) throw new Error(`${label} required file is not a file: ${file}`);
  }
  for (const directory of requiredDirectories) {
    if (!(await lstat(join(root, directory))).isDirectory()) throw new Error(`${label} required directory is not a directory: ${directory}`);
  }
}

module.exports = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const source = join(projectDir, 'desktop-dist', 'app');
  const destination = join(context.appOutDir, 'resources', RUNTIME_DIRECTORY);
  if (!(await lstat(source)).isDirectory()) throw new Error(`Staged runtime does not exist: ${source}`);
  await verifyContents(source, 'Staged runtime');
  const sourceHashes = new Map(await Promise.all(criticalFiles.map(async (file) => [file, await sha256(join(source, file))])));

  await rm(destination, {recursive: true, force: true});
  await mkdir(join(context.appOutDir, 'resources'), {recursive: true});
  await cp(source, destination, {recursive: true, dereference: true, force: true});
  await verifyContents(destination, 'Packaged runtime');

  for (const file of criticalFiles) {
    const packagedHash = await sha256(join(destination, file));
    const stagedHash = sourceHashes.get(file);
    if (packagedHash !== stagedHash) throw new Error(`Runtime copy SHA-256 mismatch for ${file}: staged=${stagedHash} packaged=${packagedHash}`);
    console.log(`[afterPack] SHA-256 ${file}: ${packagedHash}`);
  }

  const packagedRoot = await realpath(destination);
  for (const item of [
    'node_modules/better-sqlite3',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'node_modules/sql.js',
    'node_modules/sql.js/dist/sql-wasm.wasm',
  ]) {
    const physicalPath = await realpath(join(destination, item));
    if (!isPathInside(packagedRoot, physicalPath)) throw new Error(`Packaged runtime path escaped ${RUNTIME_DIRECTORY}: ${item} -> ${physicalPath}`);
    console.log(`[afterPack] contained ${item}: ${physicalPath}`);
  }
  console.log(`[afterPack] authoritative runtime copied: ${source} -> ${destination}`);
};
