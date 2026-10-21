import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCloseFlow } = require('../desktop/close-flow.cjs');
test('native save cancellation before exit keeps the app open without another picker', async () => {
  let quits = 0;
  const flow = createCloseFlow({ dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: () => { throw Error('duplicate picker'); } },
    window: () => null, saveBackup: async () => ({ ok: true, canceled: true }), approveQuit: async () => { quits++; }, onFailure: async () => {} });
  assert.equal(await flow.requestClose(), false); assert.equal(quits, 0);
});
test('exit waits for native backup acknowledgement and failure is not silently ignored', async () => {
  let quits = 0, failures = 0;
  const flow = createCloseFlow({ dialog: { showMessageBox: async () => ({ response: 0 }) }, window: () => null,
    saveBackup: async () => ({ ok: false }), approveQuit: async () => { quits++; }, onFailure: async () => { failures++; } });
  assert.equal(await flow.requestClose(), false); assert.equal(quits, 0); assert.equal(failures, 1);
});
test('main/renderer/package integrate the native service with no custom picker or fixed-folder experiment', async () => {
  const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
  const [app, main, preload, pkg] = await Promise.all(['app/conta-app.tsx','desktop/main.cjs','desktop/preload.cjs','package.json'].map(read));
  assert.match(app, /exportNativeBackup\(locale\)/);
  assert.match(app, /if\(safety.canceled\)return/);
  assert.match(app, /result.canceled/);
  assert.match(main, /saveBackup:.*nativeBackup.save/);
  assert.match(main, /await nativeBackup\?\.waitForIdle\(\)/);
  assert.match(preload, /exposeInMainWorld\('alkarnaBackup'/);
  assert.ok(JSON.parse(pkg).build.files.includes('desktop/native-backup.cjs'));
  for (const name of ['desktop/backup-picker.cjs','desktop/backup-picker.html','desktop/backup-store.cjs']) {
    await assert.rejects(access(new URL('../' + name, import.meta.url)), { code: 'ENOENT' });
  }
  assert.doesNotMatch(app, /AlKarna Backups|openBackupFolder|desktopBackupAvailable/);
});

test('native backup port preserves perfume application identity and data/license separation',async()=>{
 const main=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
 assert.match(main,/mr\.alkarna\.perfume\.desktop/);
 assert.match(main,/AlKarna-Perfume/);
 assert.match(main,/alkarna-perfume\.sqlite/);
 assert.match(main,/ALKARNA_LICENSE_DISABLE_REGISTRY/);
 const service=await readFile(new URL('../desktop/native-backup.cjs',import.meta.url),'utf8');
 assert.match(service,/AlKarna-Perfume-backup-/);
 assert.match(service,/dialog\.showSaveDialog/);
});
