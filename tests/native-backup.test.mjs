import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createNativeBackupService, registerNativeBackupHandler, trustedSender } = require('../desktop/native-backup.cjs');
const json = body => new Response(body, { headers: { 'content-type': 'application/json' } });
async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'native-backup-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const calls = [], owner = { isDestroyed: () => false };
  const target = join(home, 'selected.conta.json');
  const service = createNativeBackupService({
    homeDirectory: home, getWindow: () => owner,
    dialog: { showSaveDialog: async (window, settings) => {
      calls.push({ window, settings }); return { canceled: false, filePath: target };
    } }, ...options,
  });
  return { home, service, target, calls, owner };
}
test('opens the real async native Save As API with owner, initial folder and overwrite prompt', async t => {
  const f = await fixture(t, { getLocale: async () => 'fr' });
  const result = await f.service.save(async () => json('{}'));
  assert.equal(result.ok, true);
  assert.equal(f.calls[0].window, f.owner);
  assert.equal(dirname(f.calls[0].settings.defaultPath), f.home);
  assert.match(f.calls[0].settings.title, /Enregistrer/);
  assert.ok(f.calls[0].settings.properties.includes('showOverwriteConfirmation'));
  assert.ok(f.calls[0].settings.properties.includes('dontAddToRecent'));
  assert.equal(await fs.readFile(f.target, 'utf8'), '{}');
});
test('cancel does not fetch data, create directories/files or return success-as-saved', async t => {
  const f = await fixture(t, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(await f.service.save(() => { throw Error('must not fetch'); }), { ok: true, canceled: true });
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.equal(f.service.isActive(), false);
});
test('user may spend time choosing a USB before the transfer timeout starts; duplicate save is rejected', async t => {
  let release;
  const selection = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { timeoutMs: 100, dialog: { showSaveDialog: () => selection } });
  let fetched = false;
  const pending = f.service.save(async signal => { fetched = true; assert.equal(signal.aborted, false); return json('{}'); });
  await assert.rejects(f.service.save(async () => json('{}')), /backup-busy/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fetched, false); assert.equal(f.service.isActive(), true);
  release({ canceled: false, filePath: f.target });
  assert.equal((await pending).ok, true);
});
test('streams a backup larger than 5MiB unchanged to the selected folder', async t => {
  const f = await fixture(t), text = JSON.stringify({ records: 'ع'.repeat(3 * 1024 * 1024) });
  const result = await f.service.save(async () => json(text));
  assert.ok(result.bytes > 5 * 1024 * 1024);
  assert.equal(await fs.readFile(f.target, 'utf8'), text);
});
test('old target survives a failed stream and no partial output remains', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'old backup');
  const broken = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])); c.error(Error('read-failed')); } });
  await assert.rejects(f.service.save(async () => json(broken)), /read-failed/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'old backup');
  assert.deepEqual(await fs.readdir(f.home), ['selected.conta.json']);
});
test('success replaces only the Windows-confirmed target after the complete stream is written', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'previous');
  await fs.writeFile(join(f.home, 'other.json'), 'unrelated');
  let controller, complete = false;
  const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{')); } });
  const pending = f.service.save(async () => json(stream)).then(value => { complete = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous'); assert.equal(complete, false);
  controller.enqueue(new TextEncoder().encode('}')); controller.close(); await pending;
  assert.equal(await fs.readFile(f.target, 'utf8'), '{}');
  assert.equal(await fs.readFile(join(f.home, 'other.json'), 'utf8'), 'unrelated');
});
test('permission errors and invalid responses never replace an existing backup', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'previous');
  for (const status of [401, 403, 402, 500]) {
    await assert.rejects(f.service.save(async () => new Response('denied', { status })), e => e.status === status);
  }
  await assert.rejects(f.service.save(async () => new Response('<html>error</html>')), /invalid-backup-response/);
  await assert.rejects(f.service.save(async () => json('')), /incomplete-backup-response/);
  await assert.rejects(f.service.save(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '10' } })), /incomplete-backup-response/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(f.home), ['selected.conta.json']);
});
test('rename/USB failure preserves old target with no delete fallback and clears busy state', async t => {
  const f = await fixture(t, { io: { ...fs, rename: async () => { throw Object.assign(Error('offline USB'), { code: 'EIO' }); } } });
  await fs.writeFile(f.target, 'previous');
  await assert.rejects(f.service.save(async () => json('{}')), /offline USB/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(f.home), ['selected.conta.json']);
  assert.equal(f.service.isActive(), false);
});

test('disk-full failure before streaming preserves the previous backup and releases the save barrier', async t => {
  const f = await fixture(t, { io: { ...fs, open: async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); } } });
  await fs.writeFile(f.target, 'previous');
  await assert.rejects(f.service.save(async () => json('{}')), { code: 'ENOSPC' });
  await f.service.waitForIdle();
  assert.equal(f.service.isActive(), false);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.deepEqual(await fs.readdir(f.home), ['selected.conta.json']);
});
test('transfer timeout leaves earlier backups intact and releases the close barrier', async t => {
  const f = await fixture(t, { timeoutMs: 60 }); await fs.writeFile(f.target, 'previous');
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])); } });
  const pending = f.service.save(async () => json(stream));
  const idle = f.service.waitForIdle(); assert.equal(idle, pending);
  const keeper = setInterval(() => {}, 20);
  try { await assert.rejects(pending, /abort/i); } finally { clearInterval(keeper); }
  assert.equal(await fs.readFile(f.target, 'utf8'), 'previous');
  assert.equal(f.service.isActive(), false);
});
test('never changes an extension after native overwrite confirmation or writes to an unchosen folder', async t => {
  const f = await fixture(t, { dialog: { showSaveDialog: async () => ({ filePath: 'relative.exe' }) } });
  await assert.rejects(f.service.save(() => { throw Error('must not fetch'); }), /invalid-backup-target/);
  assert.deepEqual(await fs.readdir(f.home), []);
});
test('target modified during export is preserved instead of overwritten', async t => {
  const f = await fixture(t); await fs.writeFile(f.target, 'previous');
  await assert.rejects(f.service.save(async () => { await fs.writeFile(f.target, 'different writer'); return json('{}'); }), /backup-target-changed/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'different writer');
});
test('remembers chosen directory, falls back to home if it disappears, and uses no hard links', async t => {
  const f = await fixture(t);
  const usb = join(f.home, 'USB'); await fs.mkdir(usb);
  const starts = []; let chosen = join(usb, 'copy.json');
  const service = createNativeBackupService({ homeDirectory: f.home, getWindow: () => f.owner,
    io: { ...fs, link: () => { throw Error('hard links forbidden'); } },
    dialog: { showSaveDialog: async (_owner, settings) => { starts.push(dirname(settings.defaultPath)); return { filePath: chosen }; } } });
  await service.save(async () => json('{}')); await service.save(async () => json('{}'));
  await fs.rm(usb, { recursive: true }); chosen = f.target;
  await service.save(async () => json('{}'));
  assert.deepEqual(starts, [f.home, usb, f.home]);
});
test('manual IPC authorizes the exact main frame and uses normal licensed backup API with current cookies', async t => {
  const f = await fixture(t), handlers = new Map(), frame = { url: 'http://127.0.0.1:12000/' };
  f.owner.webContents = { mainFrame: frame, session: { cookies: { get: async () => [{ name: 'conta_session', value: 'test' }] } } };
  const event = { sender: f.owner.webContents, senderFrame: frame }; let fetched;
  registerNativeBackupHandler({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, service: f.service,
    getWindow: () => f.owner, getOrigin: () => frame.url,
    fetchResponse: async (url, options) => { fetched = { url, options }; return json('{}'); } });
  assert.equal(trustedSender({ ...event, senderFrame: { ...frame } }, f.owner, frame.url), false);
  assert.equal((await handlers.get('alkarna:backup:save')({ ...event, sender: {} })).status, 403);
  assert.equal((await handlers.get('alkarna:backup:save')(event, { path: '/evil', url: 'https://evil' })).ok, true);
  assert.equal(fetched.url, 'http://127.0.0.1:12000/api/settings/backup');
  assert.equal(fetched.options.headers.cookie, 'conta_session=test');
  assert.equal(fetched.options.headers['x-alkarna-desktop-token'], undefined);
  assert.equal(fetched.options.redirect, 'error');
});
