/* eslint-disable @typescript-eslint/no-require-imports */
const { Readable } = require('node:stream');
const { writeBackupFile } = require('./backup-file.cjs');

function runBackupWorker({ io } = {}) {
  let started = false, resolveResponse;
  const metadata = new Promise(resolve => { resolveResponse = resolve; });
  const send = message => { if (process.connected) process.send(message); };
  const finish = message => {
    if (!process.connected) return process.exit(1);
    process.send(message, () => process.exit(message.type === 'complete' ? 0 : 1));
  };
  process.on('disconnect', () => process.exit(1));
  process.on('message', message => {
    if (message?.type === 'response' && started) { resolveResponse(message); return; }
    if (message?.type !== 'start' || started) return;
    started = true;
    void writeBackupFile({
      filePath: message.filePath, io, signal: new AbortController().signal,
      log: line => send({ type: 'stage', line }),
      fetchResponse: async () => {
        send({ type: 'ready' });
        const meta = await metadata;
        return { ok: meta.ok === true, status: meta.status, headers: new Headers(meta.headers),
          body: meta.hasBody ? Readable.toWeb(process.stdin) : null };
      },
    }).then(result => finish({ type: 'complete', ...result }), error => finish({
      type: 'failed', code: error.code || 'backup-write-failed', status: error.status || null,
    }));
  });
}
if (require.main === module) runBackupWorker();
module.exports = { runBackupWorker };
