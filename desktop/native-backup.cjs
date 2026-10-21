/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function backupFilename(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `AlKarna-Perfume-backup-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.conta.json`;
}
function trustedSender(event, owner, origin) {
  try {
    return !!owner && !owner.isDestroyed() && event.sender === owner.webContents &&
      !!event.senderFrame && event.senderFrame === owner.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === new URL(origin).origin;
  } catch { return false; }
}
const failure = (code, status) => Object.assign(new Error(code), { code, status });
async function snapshot(filePath, io) {
  try {
    const stat = await io.lstat(filePath);
    // Do not replace directories, symlinks or other special files as backups.
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('invalid-backup-target');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Keep Windows' real Save As dialog. The renderer never supplies a path or URL.
// No custom picker, fixed output directory, Chromium download or Blob is involved.
function createNativeBackupService({ dialog, getWindow, homeDirectory, getLocale = async () => 'ar',
  log = () => {}, timeoutMs = 120000, waitingLogMs = 30000, io = fs }) {
  if (!path.isAbsolute(homeDirectory)) throw failure('invalid-home-directory');
  let active = null, lastDirectory = null;
  async function initialDirectory() {
    if (!lastDirectory) return homeDirectory;
    // An unplugged USB / unavailable share must not hold up opening the dialog.
    let timer;
    try {
      const exists = await Promise.race([
        io.stat(lastDirectory).then(s => s.isDirectory(), () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 400); }),
      ]);
      return exists ? lastDirectory : homeDirectory;
    } finally { clearTimeout(timer); }
  }
  function save(fetchResponse) {
    if (active) return Promise.reject(failure('backup-busy'));
    active = perform(fetchResponse);
    const task = active;
    void task.then(() => { if (active === task) active = null; }, () => { if (active === task) active = null; });
    return task;
  }
  async function perform(fetchResponse) {
    const started = Date.now(), owner = getWindow(), locale = await getLocale();
    if (!owner || owner.isDestroyed()) throw failure('window-closed');
    const directory = await initialDirectory();
    const defaultPath = path.join(directory, backupFilename());
    log('backup stage=dialog-open');
    // Diagnostic only: waiting may be normal user interaction, not a detected hang.
    const waiting = setInterval(() => log(`backup stage=dialog-pending elapsedMs=${Date.now() - started}`), waitingLogMs);
    waiting.unref?.();
    let choice;
    try {
      choice = await dialog.showSaveDialog(owner, {
        title: locale === 'fr' ? 'Enregistrer la sauvegarde' : 'حفظ النسخة الاحتياطية',
        defaultPath,
        filters: [{ name: locale === 'fr' ? 'Sauvegarde Al Karna Parfums' : 'نسخة الكرنة للعطور', extensions: ['conta.json', 'json'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      });
    } catch (error) { log(`backup stage=dialog-failed code=${error.code || 'unknown'}`); throw error; }
    finally { clearInterval(waiting); }
    if (choice.canceled || !choice.filePath) { log('backup stage=dialog-canceled'); return { ok: true, canceled: true }; }
    // Never add an extension after Windows has obtained overwrite consent.
    const filePath = choice.filePath;
    if (!path.isAbsolute(filePath) || !/\.json$/i.test(filePath) || /\0/.test(filePath)) throw failure('invalid-backup-target');
    log(`backup stage=dialog-selected elapsedMs=${Date.now() - started}`);
    const previous = await snapshot(filePath, io);
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.partial`);
    let bytes = 0, temporaryCreated = false;
    // Time spent choosing a folder must not consume the network/write timeout.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchResponse(signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure('backup-http-error', response.status);
      }
      if (!/^application\/json\b/i.test(response.headers.get('content-type') || '') || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw failure('invalid-backup-response');
      }
      // Reserve exclusively before streaming; cleanup only a file created by us.
      const handle = await io.open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      await handle.close();
      log('backup stage=writing');
      const counter = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), counter,
        createWriteStream(temporaryPath, { flags: 'r+', flush: true }), { signal });
      const declared = response.headers.get('content-length');
      if (!bytes || (!response.headers.get('content-encoding') && declared !== null && /^\d+$/.test(declared) && bytes !== Number(declared))) throw failure('incomplete-backup-response');
      // Preserve an existing backup until the replacement is complete; reject a
      // target modified by another writer after selection. No delete-then-rename.
      if (await snapshot(filePath, io) !== previous) throw failure('backup-target-changed');
      signal.throwIfAborted();
      await io.rename(temporaryPath, filePath);
      temporaryCreated = false;
      lastDirectory = path.dirname(filePath);
      log(`backup stage=saved bytes=${bytes} elapsedMs=${Date.now() - started}`);
      return { ok: true, canceled: false, filePath, bytes };
    } catch (error) {
      if (temporaryCreated) await io.rm(temporaryPath, { force: true }).catch(() => {});
      log(`backup stage=save-failed code=${error.code || error.name || 'unknown'}`);
      throw error;
    }
  }
  return { save, isActive: () => active !== null, waitForIdle: () => active || Promise.resolve() };
}
function registerNativeBackupHandler({ ipcMain, service, getWindow, getOrigin, fetchResponse, isClosing = () => false }) {
  ipcMain.handle('alkarna:backup:save', async event => {
    if (!trustedSender(event, getWindow(), getOrigin())) return { ok: false, status: 403, code: 'forbidden' };
    if (isClosing() || service.isActive()) return { ok: false, code: 'backup-busy' };
    try {
      return await service.save(async signal => {
        const url = new URL('/api/settings/backup', getOrigin()).href;
        const cookies = await event.sender.session.cookies.get({ url });
        return fetchResponse(url, { signal, redirect: 'error', cache: 'no-store', headers: {
          cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), 'accept-encoding': 'identity',
        } });
      });
    } catch (error) { return { ok: false, code: error.code || 'backup-failed', status: error.status || null }; }
  });
}
module.exports = { backupFilename, trustedSender, createNativeBackupService, registerNativeBackupHandler };
