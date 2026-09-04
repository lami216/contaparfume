/* eslint-disable @typescript-eslint/no-require-imports -- Electron Node-mode probe is CommonJS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');

const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const stagedApp = fs.realpathSync(path.join(repositoryRoot, 'desktop-dist', 'app'));
const serverRequire = createRequire(path.join(stagedApp, 'server.js'));
const packagePath = fs.realpathSync(serverRequire.resolve('better-sqlite3'));
const nativePath = fs.realpathSync(serverRequire.resolve('better-sqlite3/build/Release/better_sqlite3.node'));
const isInside = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);

for (const [label, candidate] of [['package', packagePath], ['native binary', nativePath]]) {
  assert.ok(isInside(candidate, stagedApp), `Staged ${label} escaped the app: ${candidate}`);
  assert.ok(!isInside(candidate, repositoryRoot) || isInside(candidate, stagedApp));
}

if (!process.env.ALKARNA_ELECTRON_SQLITE_CHILD) {
  console.log(`STAGED resolved better-sqlite3 package path: ${packagePath}`);
  console.log(`STAGED better_sqlite3.node realpath: ${nativePath}`);
  const result = spawnSync(require('electron'), [__filename], {
    cwd: stagedApp,
    stdio: 'inherit',
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', ALKARNA_ELECTRON_SQLITE_CHILD: '1'},
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

console.log(`STAGED Electron version: ${process.versions.electron}`);
console.log(`STAGED Electron module ABI: ${process.versions.modules}`);
console.log(`STAGED resolved better-sqlite3 package path: ${packagePath}`);
console.log(`STAGED better_sqlite3.node realpath: ${nativePath}`);
const Database = serverRequire('better-sqlite3');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'alkarna-electron-sqlite-'));
let database;
try {
  database = new Database(path.join(temporaryDirectory, 'smoke.sqlite'));
  database.exec('CREATE TABLE smoke_test (value TEXT NOT NULL)');
  database.prepare('INSERT INTO smoke_test (value) VALUES (?)').run('electron-abi-ok');
  assert.equal(database.prepare('SELECT value FROM smoke_test').get().value, 'electron-abi-ok');
  console.log('Electron server-context CREATE / INSERT / SELECT smoke passed.');
} finally {
  database?.close();
  fs.rmSync(temporaryDirectory, {recursive: true, force: true});
}
