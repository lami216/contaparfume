import test from 'node:test';
import assert from 'node:assert/strict';
import { exportNativeBackup } from '../app/backup-export.ts';
function globals(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window; });
}
test('native cancel is not success and never falls back to a blob downloader', async t => {
  globals(t, { alkarnaBackup: { save: async () => ({ ok: true, canceled: true }) } });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('no browser fallback'); });
  assert.deepEqual(await exportNativeBackup('ar'), { saved: false, canceled: true });
});
test('native success is acknowledged only after write reply', async t => {
  let release, settled = false;
  globals(t, { alkarnaBackup: { save: () => new Promise(resolve => { release = resolve; }) } });
  const pending = exportNativeBackup('fr').then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(settled, false);
  release({ ok: true, filePath: 'E:\\copies\\backup.conta.json' });
  assert.equal((await pending).saved, true);
});
test('permission, changed destination and disk-full failures remain errors in both languages', async t => {
  let reply; globals(t, { alkarnaBackup: { save: async () => reply } });
  reply = { ok: false, status: 403 }; await assert.rejects(exportNativeBackup('ar'), /صلاحية/);
  reply = { ok: false, code: 'ENOSPC' }; await assert.rejects(exportNativeBackup('fr'), /Espace/);
  reply = { ok: false, code: 'backup-target-changed' }; await assert.rejects(exportNativeBackup('ar'), /لم نستبدله/);
});
