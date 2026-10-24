/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const failure = (code, status) => Object.assign(new Error(code), { code, status });

async function snapshot(filePath, io) {
  try {
    const stat = await io.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('invalid-backup-target');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Runs in the disposable writer process in the desktop application. Keeping
// this routine separate also permits deterministic filesystem fault tests.
async function writeBackupFile({ filePath, fetchResponse, signal, log = () => {}, io = fs }) {
  if (!path.isAbsolute(filePath) || !/\.json$/i.test(filePath) || /\0/.test(filePath)) throw failure('invalid-backup-target');
  const previous = await snapshot(filePath, io);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.partial`);
  let bytes = 0, temporaryCreated = false;
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
    const handle = await io.open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.close();
    log('backup stage=writing');
    const counter = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), counter,
      createWriteStream(temporaryPath, { flags: 'r+', flush: true }), { signal });
    const declared = response.headers.get('content-length');
    if (!bytes || (!response.headers.get('content-encoding') && declared !== null && /^\d+$/.test(declared) && bytes !== Number(declared))) throw failure('incomplete-backup-response');
    log('backup stage=committing');
    if (await snapshot(filePath, io) !== previous) throw failure('backup-target-changed');
    signal.throwIfAborted();
    await io.rename(temporaryPath, filePath);
    temporaryCreated = false;
    return { bytes };
  } catch (error) {
    if (temporaryCreated) await io.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
module.exports = { writeBackupFile };
