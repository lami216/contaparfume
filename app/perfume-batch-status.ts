import type { PerfumeLot } from "./perfume-logic.ts";

export type PerfumeBatchStatus = "active" | "ended" | "settled" | "recombined";

/** Availability belongs to the whole lot, even while viewing one warehouse. */
export function perfumeBatchQuantity(lot: Pick<PerfumeLot, "stocks">): number {
  return Object.values(lot.stocks ?? {}).reduce((sum, quantity) =>
    sum + (Number.isFinite(Number(quantity)) ? Number(quantity) : 0), 0);
}

/** An exhausted sale is display history, not an implicit settlement. */
export function perfumeBatchStatus(lot: Pick<PerfumeLot, "stocks" | "settledAt" | "recombinedAt">): PerfumeBatchStatus {
  if (lot.recombinedAt) return "recombined";
  if (lot.settledAt) return "settled";
  return perfumeBatchQuantity(lot) > 1e-9 ? "active" : "ended";
}

/** Selects one balance view only; grouping never changes the original independent lots. */
export function groupPerfumeBatches<T extends { lot: PerfumeLot }>(rows: readonly T[], showClosed = false): {
  sourceProductId: string;
  sourceProductName: string;
  batches: T[];
}[] {
  const groups = new Map<string, { sourceProductId: string; sourceProductName: string; batches: T[] }>();
  for (const row of rows) {
    const closed = perfumeBatchQuantity(row.lot) <= 1e-9;
    if (closed !== showClosed) continue;
    const sourceProductId = String(row.lot.sourceProductId ?? "");
    // Missing legacy source identities must never merge unrelated lots by name.
    const key = sourceProductId || `lot:${row.lot.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { sourceProductId, sourceProductName: row.lot.sourceProductName, batches: [] };
      groups.set(key, group);
    }
    group.batches.push(row);
  }
  return [...groups.values()];
}
