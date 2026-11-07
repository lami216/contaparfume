import { performance } from "node:perf_hooks";

export const COMMAND_PREFLIGHT_TIMEOUT_MS = 10_000;
export const COMMAND_QUEUE_TIMEOUT_MS = 30_000;
export class CommandAdmissionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export type CommandAdmissionContext = {
  preflight<T>(operation: Promise<T>): Promise<T>;
  readJson(): Promise<unknown>;
  assertCanMutate(): void;
};
type AdmissionState = { tail: Promise<void> };
type AdmissionOptions = { preflightTimeoutMs?: number; queueTimeoutMs?: number };
type Admission = <T>(request: Request, work: (context: CommandAdmissionContext) => Promise<T>) => Promise<T>;
const canceled = () => new CommandAdmissionError("أُلغي طلب العملية قبل الحفظ؛ أعد المحاولة إذا لزم الأمر", 408);

function bounded<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number, timeout: () => CommandAdmissionError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer: { current?: ReturnType<typeof setTimeout> } = {};
    const expiresAt = performance.now() + Math.max(0, timeoutMs);
    const finish = (failed: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
      signal.removeEventListener("abort", abort);
      if (failed) reject(value); else resolve(value as T);
    };
    const abort = () => finish(true, canceled());
    // Always observe the underlying read, including a late rejection after timeout.
    operation.then(value => {
      // JSON parsing can occupy the event loop past the timer's due time. A late
      // microtask must not win merely because the timeout callback has not run yet.
      if (performance.now() >= expiresAt) finish(true, timeout()); else finish(false, value);
    }, error => finish(true, error));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs <= 0) { finish(true, timeout()); return; }
    timer.current = setTimeout(() => finish(true, timeout()), timeoutMs);
  });
}

function admission(state: AdmissionState, options: AdmissionOptions): Admission {
  const preflightTimeoutMs = options.preflightTimeoutMs ?? COMMAND_PREFLIGHT_TIMEOUT_MS;
  const queueTimeoutMs = options.queueTimeoutMs ?? COMMAND_QUEUE_TIMEOUT_MS;
  if (![preflightTimeoutMs, queueTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error("Invalid command admission deadline");
  return async (request, work) => {
    // This ticket is assigned before any asynchronous license or body work. A
    // canceled queued ticket must still wait for its predecessor before releasing.
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await bounded(previous, request.signal, queueTimeoutMs, () => new CommandAdmissionError("تعذر بدء العملية في الوقت المحدد؛ أعد المحاولة", 503));
    } catch (error) {
      void previous.then(release, release);
      throw error;
    }
    const deadline = performance.now() + preflightTimeoutMs;
    try {
      if (request.signal.aborted) throw canceled();
      return await work({
        preflight: operation => bounded(operation, request.signal, deadline - performance.now(), () => new CommandAdmissionError("تعذر التحقق من الطلب في الوقت المحدد؛ أعد المحاولة", 503)),
        readJson: () => bounded(Promise.resolve().then(() => request.json()), request.signal, deadline - performance.now(), () => new CommandAdmissionError("انتهت مهلة قراءة طلب العملية؛ أعد المحاولة", 408)),
        assertCanMutate: () => { if (request.signal.aborted) throw canceled(); },
      });
    } finally {
      // Never race/release a running stock or financial mutation. Its existing
      // transaction must commit or roll back before the following command starts.
      release();
    }
  };
}

/** Separate queues/deadlines for isolated tests; production uses the shared gate. */
export function createCommandAdmission(options: AdmissionOptions = {}): Admission {
  return admission({ tail: Promise.resolve() }, options);
}
// One desktop server process may load more than one route-module instance. Keep
// their admission order shared without opening a database while a body is pending.
const processGlobal = globalThis as typeof globalThis & { __alkarnaCommandAdmissionV1?: AdmissionState };
const shared = processGlobal.__alkarnaCommandAdmissionV1 ??= { tail: Promise.resolve() };
export const withCommandAdmission = admission(shared, {});
