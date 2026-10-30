/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const failure = (code, status) => Object.assign(new Error(code), { code, status });

function createIsolatedBackupWriter({ executable = process.execPath,
  workerPath = path.join(__dirname, 'backup-write-worker.cjs'), spawnProcess = spawn } = {}) {
  return async function write({ filePath, fetchResponse, signal, log = () => {} }) {
    signal.throwIfAborted();
    log('backup stage=writer-starting');
    const child = spawnProcess(executable, [workerPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    let readyResolve, readyReject, resultResolve, resultReject, settled = false;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    // Either promise may reject while its peer is currently being awaited.
    void ready.catch(() => {}); void result.catch(() => {});
    const reject = error => {
      if (settled) return;
      settled = true; readyReject(error); resultReject(error);
    };
    const abort = () => {
      // Do not wait for a stuck disk operation or child exit before releasing
      // the UI/close barrier. The worker never deletes the previous backup.
      reject(failure('backup-write-timeout'));
      child.stdin?.destroy(); child.kill();
    };
    child.on('error', () => reject(failure('backup-worker-failed')));
    child.stdin?.on('error', () => { /* pipeline reports pipe failures */ });
    child.stderr?.resume();
    child.on('exit', () => { if (!settled) reject(failure('backup-worker-failed')); });
    child.on('message', message => {
      if (settled) return;
      if (message?.type === 'ready') readyResolve();
      else if (message?.type === 'stage' && typeof message.line === 'string') log(message.line);
      else if (message?.type === 'failed') reject(failure(message.code || 'backup-write-failed', message.status));
      else if (message?.type === 'complete' && Number.isSafeInteger(message.bytes) && message.bytes > 0) {
        settled = true; resultResolve({ bytes: message.bytes });
      }
    });
    const send = message => new Promise((resolve, rejectSend) => {
      if (!child.connected) return rejectSend(failure('backup-worker-failed'));
      child.send(message, error => error ? rejectSend(failure('backup-worker-failed')) : resolve());
    });
    signal.addEventListener('abort', abort, { once: true });
    // Cover an abort occurring between process creation and listener setup.
    if (signal.aborted) abort();
    let response;
    try {
      await send({ type: 'start', filePath });
      await ready;
      log('backup stage=fetching');
      // Abort must also bound a response provider which ignores its signal.
      response = await Promise.race([fetchResponse(signal), result]);
      await send({ type: 'response', ok: response.ok, status: response.status,
        headers: [...response.headers.entries()], hasBody: !!response.body });
      if (response.ok && /^application\/json\b/i.test(response.headers.get('content-type') || '') && response.body) {
        log('backup stage=streaming');
        const transfer = pipeline(Readable.fromWeb(response.body), child.stdin, { signal });
        await Promise.all([transfer, result]);
      } else {
        await response.body?.cancel().catch(() => {});
        child.stdin.end();
      }
      return await result;
    } catch (error) {
      reject(error); child.stdin?.destroy(); child.kill();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (child.connected) child.disconnect();
      // Failed/disconnected media may retain an uncommitted .partial file;
      // cleanup must never hang the application or delete the selected backup.
    }
  };
}
module.exports = { createIsolatedBackupWriter };
