import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {isPathInside} = require('../scripts/path-containment.cjs');

const windowsRepository = String.raw`D:\a\offline-conta\offline-conta`;

test('Windows same-drive child is inside', () => {
  assert.equal(isPathInside(windowsRepository, String.raw`D:\a\offline-conta\offline-conta\desktop-dist`, path.win32), true);
});

test('Windows sibling prefix is outside', () => {
  assert.equal(isPathInside(windowsRepository, String.raw`D:\a\offline-conta\offline-conta2`, path.win32), false);
});

test('Windows parent is outside', () => {
  assert.equal(isPathInside(windowsRepository, String.raw`D:\a\offline-conta`, path.win32), false);
});

test('Windows cross-drive temporary directory is outside', () => {
  assert.equal(isPathInside(windowsRepository, String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\alkarna-test`, path.win32), false);
});

test('Windows cross-drive dependency is outside', () => {
  assert.equal(isPathInside(String.raw`C:\Temp\package`, String.raw`D:\repo\node_modules\better-sqlite3`, path.win32), false);
});

test('POSIX path containment handles children and sibling prefixes', () => {
  assert.equal(isPathInside('/repo/app', '/repo/app/subdir', path.posix), true);
  assert.equal(isPathInside('/repo/app', '/repo/app2', path.posix), false);
  assert.equal(isPathInside('/repo/app', '/tmp/package', path.posix), false);
});
