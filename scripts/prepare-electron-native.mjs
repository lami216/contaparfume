import {access, cp, lstat, realpath, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {rebuild} from '@electron/rebuild';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const stagedApp = path.resolve('desktop-dist/app');
const moduleRoot = path.join(stagedApp, 'node_modules');
const nativeModule = path.join(moduleRoot, 'better-sqlite3');
const nativeBinary = path.join(nativeModule, 'build/Release/better_sqlite3.node');
const sourceModule = path.resolve('node_modules/better-sqlite3');

await access(nativeModule);

// Next's standalone trace contains only runtime files, not binding.gyp or C++ sources.
// Restore the installed package into the staged tree so this copy can be rebuilt in place.
await rm(nativeModule, {recursive: true, force: true});
await cp(sourceModule, nativeModule, {recursive: true, dereference: true});
if ((await lstat(nativeModule)).isSymbolicLink()) {
  throw new Error(`Staged better-sqlite3 must be a physical copy, not a link: ${nativeModule}`);
}

console.log(
  `Rebuilding staged better-sqlite3 for Electron ${electronVersion} (${process.platform}, x64)`,
);

await rebuild({
  buildPath: stagedApp,
  electronVersion,
  platform: process.platform,
  arch: 'x64',
  onlyModules: ['better-sqlite3'],
  force: true,
  buildFromSource: true,
});

await access(nativeBinary);
if ((await lstat(nativeModule)).isSymbolicLink()) {
  throw new Error(`Electron rebuild converted staged better-sqlite3 into a link: ${nativeModule}`);
}
for (const candidate of [nativeModule, nativeBinary]) {
  const physical = await realpath(candidate);
  const relative = path.relative(stagedApp, physical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Rebuilt native path escapes the staged app: ${candidate} -> ${physical}`);
  }
  console.log(`Staged physical path after rebuild: ${physical}`);
}
console.log(`Staged Electron native binary ready: ${nativeBinary}`);
