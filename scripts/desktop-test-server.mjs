import {spawn, spawnSync} from 'node:child_process';
import {access, copyFile, cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import process from 'node:process';

const require = createRequire(import.meta.url);
const {isPathInside} = require('./path-containment.cjs');
const repositoryRoot = await realpath(process.cwd());
const packaged = process.argv.includes('--packaged');
const RUNTIME_DIRECTORY = 'alkarna-runtime';
let relocatedPackageDirectory;

async function packagedRuntime() {
  const dist = join(repositoryRoot, 'dist');
  const trees = (await readdir(dist, {withFileTypes: true})).filter((item) => item.isDirectory() && item.name.endsWith('unpacked'));
  const preferred = trees.filter((item) => item.name.toLowerCase() === 'win-unpacked');
  if (preferred.length !== 1) throw new Error(`Expected electron-builder win-unpacked tree, found: ${trees.map((x) => x.name).join(', ') || 'none'}`);
  const tree = join(dist, preferred[0].name);
  relocatedPackageDirectory = await mkdtemp(join(tmpdir(), 'alkarna-win-unpacked-'));
  if (isPathInside(repositoryRoot, relocatedPackageDirectory)) {
    throw new Error(`Packaged relocation must be outside the repository: ${relocatedPackageDirectory}`);
  }
  const relocatedTree = join(relocatedPackageDirectory, preferred[0].name);
  await cp(tree, relocatedTree, {recursive: true, dereference: true});
  const executable = (await readdir(relocatedTree)).find((file) => file === 'الكرنه.exe');
  if (!executable) throw new Error(`Packaged Electron executable missing from ${relocatedTree}`);
  console.log(`PACKAGED relocated win-unpacked: ${relocatedTree}`);
  return {root: join(relocatedTree, 'resources', RUNTIME_DIRECTORY), electronExecutable: join(relocatedTree, executable)};
}

async function main() {
try {
if (packaged) {
  const [desktopMain, afterPackHook] = await Promise.all([
    readFile(join(repositoryRoot, 'desktop', 'main.cjs'), 'utf8'),
    readFile(join(repositoryRoot, 'scripts', 'electron-after-pack.cjs'), 'utf8'),
  ]);
  if (!desktopMain.includes("join(process.resourcesPath,'alkarna-runtime')")) throw new Error('desktop/main.cjs packaged runtime contract drifted');
  if (!afterPackHook.includes("const RUNTIME_DIRECTORY = 'alkarna-runtime'")) throw new Error('electron-after-pack runtime contract drifted');
  console.log(`PACKAGED runtime contract: main, afterPack, and test use resources/${RUNTIME_DIRECTORY}`);
}
const runtime = packaged
  ? await packagedRuntime()
  : {root: process.argv[2] ?? join(repositoryRoot, 'desktop-dist', 'app'), electronExecutable: require('electron')};
const root = await realpath(runtime.root);
const entry = join(root, 'server.js');
const runtimeRequire = createRequire(entry);
const requiredLocalFiles = [
  'node_modules/better-sqlite3/package.json',
  'node_modules/better-sqlite3/lib/index.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/sql.js/package.json',
  'node_modules/sql.js/dist/sql-wasm.wasm',
];
for (const file of requiredLocalFiles) {
  const metadata = await lstat(join(root, file));
  if (!metadata.isFile()) throw new Error(`${packaged ? 'PACKAGED' : 'STAGED'} local dependency is not a file: ${file}`);
}
console.log(`${packaged ? 'PACKAGED' : 'STAGED'} local dependency existence: passed`);
const resolvedDependencies = new Map();
for (const specifier of ['better-sqlite3', 'better-sqlite3/build/Release/better_sqlite3.node', 'sql.js']) {
  const resolved = await realpath(runtimeRequire.resolve(specifier));
  if (!isPathInside(root, resolved)) throw new Error(`${packaged ? 'Packaged' : 'Staged'} resolution escaped runtime: ${specifier} -> ${resolved}`);
  resolvedDependencies.set(specifier, resolved);
}
const wasm = await realpath(join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
if (!isPathInside(root, wasm)) throw new Error(`${packaged ? 'Packaged' : 'Staged'} sql.js WASM escaped runtime: ${wasm}`);

// Build paths serialized in Next-generated configuration are metadata, not proof
// of a runtime dependency. Inspect actual filesystem links instead: every link in
// a dependency tree must resolve to a physical target within the shipped app.
async function auditLinks(directory) {
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const file = join(directory, item.name);
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) {
      const target = await realpath(file);
      if (!isPathInside(root, target)) throw new Error(`${packaged ? 'Packaged' : 'Staged'} link escaped runtime: ${file} -> ${target}`);
    } else if (metadata.isDirectory()) {
      await auditLinks(file);
    }
  }
}
for (const dependencyTree of [join(root, '.next', 'node_modules'), join(root, 'node_modules', 'better-sqlite3'), join(root, 'node_modules', 'sql.js')]) {
  await auditLinks(dependencyTree);
}

// These relocatable shims are generated by this repository, so unlike arbitrary
// Next output their source is appropriately checked for a hard-coded checkout.
for (const item of await readdir(join(root, '.next', 'node_modules'), {withFileTypes: true})) {
  if (!item.isDirectory() || !['better-sqlite3-', 'sql.js-'].some((prefix) => item.name.startsWith(prefix))) continue;
  const shim = join(root, '.next', 'node_modules', item.name, 'index.cjs');
  await access(shim);
  if ((await readFile(shim, 'utf8')).includes(repositoryRoot)) throw new Error(`Generated runtime shim hard-codes the checkout: ${shim}`);
}

const label = packaged ? 'PACKAGED' : 'STAGED';
console.log(`${label} SERVER CONTEXT`);
console.log(`${label} resolved better-sqlite3: ${resolvedDependencies.get('better-sqlite3')}`);
console.log(`${label} better_sqlite3.node realpath: ${resolvedDependencies.get('better-sqlite3/build/Release/better_sqlite3.node')}`);
console.log(`${label} resolved sql.js: ${resolvedDependencies.get('sql.js')}`);
console.log(`${label} sql-wasm.wasm realpath: ${wasm}`);
console.log(`${label} dependency link containment: passed`);

async function treeSize(directory) {
  let bytes = 0;
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const file = join(directory, item.name);
    const metadata = await lstat(file);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) bytes += await treeSize(file);
    else bytes += metadata.size;
  }
  return bytes;
}
for (const unrelated of ['.git', 'dist', 'desktop-dist']) {
  try { await access(join(root, unrelated)); throw new Error(`${label} runtime contains unrelated repository tree: ${unrelated}`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
console.log(`${label} runtime size: ${((await treeSize(root)) / 1024 / 1024).toFixed(1)} MiB; unrelated repository trees: none`);

let probeScript = join(repositoryRoot, 'scripts', 'electron-runtime-probe.cjs');
if (packaged) {
  probeScript = join(relocatedPackageDirectory, 'electron-runtime-probe.cjs');
  await copyFile(join(repositoryRoot, 'scripts', 'path-containment.cjs'), join(relocatedPackageDirectory, 'path-containment.cjs'));
  await writeFile(probeScript, `const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {createRequire}=require('node:module');const {isPathInside}=require('./path-containment.cjs');const root=fs.realpathSync(process.argv[2]);const runtimeRequire=createRequire(path.join(root,'server.js'));const packagePath=fs.realpathSync(runtimeRequire.resolve('better-sqlite3'));const nativePath=fs.realpathSync(runtimeRequire.resolve('better-sqlite3/build/Release/better_sqlite3.node'));assert.ok(isPathInside(root,packagePath),'package escaped runtime: '+packagePath);assert.ok(isPathInside(root,nativePath),'native escaped runtime: '+nativePath);console.log('PACKAGED Electron version: '+process.versions.electron);console.log('PACKAGED Electron module ABI: '+process.versions.modules);console.log('PACKAGED resolved better-sqlite3 package path: '+packagePath);console.log('PACKAGED better_sqlite3.node realpath: '+nativePath);const temporaryDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'alkarna-runtime-probe-'));const database=new (runtimeRequire('better-sqlite3'))(path.join(temporaryDirectory,'probe.sqlite'));try{database.exec('CREATE TABLE probe (value TEXT NOT NULL)');database.prepare('INSERT INTO probe VALUES (?)').run('ok');assert.equal(database.prepare('SELECT value FROM probe').get().value,'ok');console.log('PACKAGED native SQLite CREATE/INSERT/SELECT: passed')}finally{database.close();fs.rmSync(temporaryDirectory,{recursive:true,force:true})}`);
}
const probe = spawnSync(runtime.electronExecutable, [probeScript, root, packaged ? 'PACKAGED' : 'STAGED'], {
  cwd: root,
  stdio: 'inherit',
  env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
});
if (probe.error) throw probe.error;
if (probe.status !== 0) throw new Error(`${packaged ? 'Packaged' : 'Staged'} Electron native probe failed with ${probe.status}`);

const directory = await mkdtemp(join(tmpdir(), 'alkarna-packaged-server-'));
const port = await new Promise((resolvePort, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolvePort(value)); }); server.on('error', reject); });
const origin = `http://127.0.0.1:${port}`;
const env = {...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: directory, ALKARNA_DATABASE_PATH: join(directory, 'data', 'alkarna.sqlite'), HOSTNAME: '127.0.0.1', PORT: String(port)};
let child;
const start = () => { console.log(`Starting ${basename(runtime.electronExecutable)} with ${entry}`); child = spawn(runtime.electronExecutable, [entry], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']}); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); };
const stop = () => new Promise((done) => { if (!child || child.exitCode !== null) return done(); child.once('exit', done); child.kill(); });
const wait = async () => {
  let repeatedFatal = null;
  let repeatedCount = 0;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`${label} server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status === 200) return;
      const body = await response.text();
      if (response.status !== 500) console.error(`${label} health response (HTTP ${response.status}):\n${body}`);
      if (response.status === 500) {
        if (body === repeatedFatal) repeatedCount++; else { repeatedFatal = body; repeatedCount = 1; }
        if (repeatedCount === 1) console.error(`Fatal health response (HTTP 500):\n${body}`);
        if (repeatedCount >= 3) throw new Error(`Health returned the same fatal HTTP 500 response ${repeatedCount} times`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Health returned')) throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`${label} server health timeout`);
};
const jsonResponse = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text; }
  return {status: response.status, ok: response.ok, body};
};
const expectJson = (description, response, expectedStatus, predicate) => {
  if (response.status !== expectedStatus || !predicate(response.body)) {
    throw new Error(`${description}: expected status ${expectedStatus}; actual status ${response.status}; actual body ${JSON.stringify(response.body)}`);
  }
};
const assertUnlicensedState = async ({includeDeviceAndCommand = false} = {}) => {
  const licenseStatus = await jsonResponse(`${origin}/api/license/status`);
  expectJson(`${label} license status`, licenseStatus, 200, (body) => body?.valid === false);
  console.log(`${label} zero-user direct access: passed`);
  console.log(`${label} license status: unlicensed as expected`);

  if (includeDeviceAndCommand) {
    const device = await jsonResponse(`${origin}/api/license/device`);
    expectJson(`${label} license device`, device, 200, (body) => /^AKD-(?:[A-F0-9]{4}-){4}[A-F0-9]{4}$/.test(body?.deviceId));
    console.log(`${label} device code: ${device.body.deviceId}`);
  }

  const bootstrap = await jsonResponse(`${origin}/api/bootstrap`);
  expectJson(`${label} bootstrap license gate`, bootstrap, 402, (body) => body?.code === 'LICENSE_REQUIRED');
  console.log(`${label} bootstrap license gate: passed`);

  if (includeDeviceAndCommand) {
    const command = await jsonResponse(`${origin}/api/command`, {method: 'POST', headers: {Origin: origin, Host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'Idempotency-Key': 'desktop-smoke-product'}, body: JSON.stringify({type: 'product.create', name: 'Desktop smoke product'})});
    expectJson(`${label} command license gate`, command, 402, (body) => body?.code === 'LICENSE_REQUIRED');
    console.log(`${label} command license gate: passed`);
  }
};

try {
  start(); await wait();
  console.log(`${label} /api/health: 200`);
  await assertUnlicensedState({includeDeviceAndCommand: true});
  await stop(); start(); await wait();
  await assertUnlicensedState();
  console.log(`${label} restart zero-user direct mode: passed`);
  console.log(`${packaged ? 'packaged' : 'staged'} desktop server smoke passed`);
} finally { await stop(); await rm(directory, {recursive: true, force: true}); }
} finally {
  if (relocatedPackageDirectory) await rm(relocatedPackageDirectory, {recursive: true, force: true});
}
}

await main();
