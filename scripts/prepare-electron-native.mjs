import {access, cp, lstat, realpath, rm} from 'node:fs/promises';
import path from 'node:path';

const stagedApp = path.resolve('desktop-dist/app');
const moduleRoot = path.join(stagedApp, 'node_modules');
const nativeModule = path.join(moduleRoot, 'better-sqlite3');
const sourceModule = path.resolve('node_modules/better-sqlite3');
const prebuiltBinary = path.join(nativeModule, 'prebuilds', `${process.platform}-x64.node`);

await access(nativeModule);

// Next's standalone trace can omit package-owned native assets. Copy the complete
// better-sqlite3 package so its N-API prebuild remains physically inside the staged app.
await rm(nativeModule, {recursive: true, force: true});
await cp(sourceModule, nativeModule, {recursive: true, dereference: true});
if ((await lstat(nativeModule)).isSymbolicLink()) {
  throw new Error(`Staged better-sqlite3 must be a physical copy, not a link: ${nativeModule}`);
}

await access(prebuiltBinary);
for (const candidate of [nativeModule, prebuiltBinary]) {
  const physical = await realpath(candidate);
  const relative = path.relative(stagedApp, physical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Staged native path escapes the staged app: ${candidate} -> ${physical}`);
  }
  console.log(`Staged physical path: ${physical}`);
}
console.log(`Staged better-sqlite3 N-API binary ready: ${prebuiltBinary}`);
