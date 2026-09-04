/* eslint-disable @typescript-eslint/no-require-imports -- Executed by Electron in Node mode. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {isPathInside} = require('./path-containment.cjs');

const root = fs.realpathSync(process.argv[2]);
const label = process.argv[3] || 'RUNTIME';
const runtimeRequire = createRequire(path.join(root, 'server.js'));
const packagePath = fs.realpathSync(runtimeRequire.resolve('better-sqlite3'));
const nativePath = fs.realpathSync(runtimeRequire.resolve('better-sqlite3/build/Release/better_sqlite3.node'));
assert.ok(isPathInside(root, packagePath), `${label} package escaped runtime: ${packagePath}`);
assert.ok(isPathInside(root, nativePath), `${label} native binary escaped runtime: ${nativePath}`);
console.log(`${label} Electron version: ${process.versions.electron}`);
console.log(`${label} Electron module ABI: ${process.versions.modules}`);
console.log(`${label} resolved better-sqlite3 package path: ${packagePath}`);
console.log(`${label} better_sqlite3.node realpath: ${nativePath}`);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'alkarna-runtime-probe-'));
const database = new (runtimeRequire('better-sqlite3'))(path.join(temporaryDirectory, 'probe.sqlite'));
try {
  database.exec('CREATE TABLE probe (value TEXT NOT NULL)');
  database.prepare('INSERT INTO probe VALUES (?)').run('ok');
  assert.equal(database.prepare('SELECT value FROM probe').get().value, 'ok');
} finally {
  database.close();
  fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
