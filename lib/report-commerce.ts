/** Missing data is not a zero price. Old numeric strings remain readable. */
export function reportCostNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  if (typeof value === "string" && !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Work with copies: historical raw prices, payments and cost snapshots are immutable.
 * Allocate a header discount once, over every line, before any product filter. */
export function reportNetLines<T extends { lineTotal?: unknown }>(document: { total?: unknown; lines?: T[] }): T[] {
  const lines = document.lines ?? [], values = lines.map(line => reportCostNumber(line.lineTotal));
  if (values.some(value => value === null)) return lines;
  const gross = values.reduce<number>((sum, value) => sum + (value ?? 0), 0), total = reportCostNumber(document.total);
  if (total === null || gross <= 0 || total >= gross) return lines;
  const last = values.findLastIndex(value => (value ?? 0) > 0);
  let allocated = 0;
  return lines.map((line, index) => {
    const weight = values[index] ?? 0;
    const amount = weight === 0 ? 0 : index === last ? total - allocated : Math.min(total - allocated, Math.round(total * weight / gross * 1e6) / 1e6);
    allocated += amount;
    return { ...line, lineTotal: amount };
  });
}

export type HistoricalReportCost = { at: string; sequence: number; value: unknown };
/** Select the latest source first. An invalid or ambiguous latest source cannot
 * be replaced by an older cheaper purchase or an unrelated opening balance. */
export function latestReportCost(rows: HistoricalReportCost[], at: string): { present: boolean; cost: number | null } {
  const eligible = rows.filter(row => row.at <= at).sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence);
  const latest = eligible.at(-1);
  if (!latest) return { present: false, cost: null };
  const tied = eligible.filter(row => row.at === latest.at && row.sequence === latest.sequence);
  const values = tied.map(row => reportCostNumber(row.value));
  const cost = values[0];
  return { present: true, cost: cost !== null && cost > 0 && values.every(value => value === cost) ? cost : null };
}
