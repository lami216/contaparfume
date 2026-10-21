type OpeningCorrection = {
  type?: unknown; status?: unknown; isReversal?: unknown; occurredAt?: unknown;
  openingCorrectionSequence?: unknown; openingBalanceAfter?: unknown;
};
const sequence = (row: OpeningCorrection) => {
  const value = Number(row.openingCorrectionSequence);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** Posting order is persisted: wall-clock timestamps and UUIDs are not clocks. */
export function nextOpeningCorrectionSequence(rows: OpeningCorrection[]) {
  const next = rows.reduce((max, row) => Math.max(max, sequence(row)), 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Opening correction sequence exhausted');
  return next;
}

export function selectLatestOpeningCorrection<T extends OpeningCorrection>(rows: T[], currentOpening: unknown): T | null {
  const active = rows.filter(row => row.type === 'opening-balance-correction' && row.status !== 'reversed' && row.isReversal !== true);
  if (!active.length) return null;
  const lastSequence = Math.max(...active.map(sequence));
  if (lastSequence > 0) {
    const candidates = active.filter(row => sequence(row) === lastSequence);
    return candidates.length === 1 ? candidates[0] : null;
  }
  // Legacy records are not rewritten. For a tied timestamp, a unique terminal
  // balance can identify the last correction. Ambiguous cycles remain guarded.
  const lastTime = active.reduce((time, row) => String(row.occurredAt ?? '') > time ? String(row.occurredAt) : time, '');
  const candidates = active.filter(row => String(row.occurredAt ?? '') === lastTime);
  if (candidates.length === 1) return candidates[0];
  const terminal = candidates.filter(row => row.openingBalanceAfter != null && Number(row.openingBalanceAfter) === Number(currentOpening));
  return terminal.length === 1 ? terminal[0] : null;
}
