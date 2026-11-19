import { isOpeningStockDocument } from "./stock-movement.ts";

type SettlementHint = Parameters<typeof isOpeningStockDocument>[0] & {
  perfumeManagementType?: unknown;
  perfumeStockOperationType?: unknown;
  perfumeConversionType?: unknown;
  settlementSequence?: unknown;
};

/** A stock count is a separate numbering family, never every adjustment row. */
export function isStockSettlementDocument(document: SettlementHint): boolean {
  if (!document || document.kind !== "adjustment" || document.productArchiveStockClearance === true || isOpeningStockDocument(document)) return false;
  const management = String(document.perfumeManagementType ?? "");
  const operation = String(document.perfumeStockOperationType ?? "");
  const conversion = String(document.perfumeConversionType ?? "");
  if (conversion || [management, operation].some(value => ["opening", "split", "recombine", "consumption", "bottle", "unit-conversion"].includes(value))) return false;
  // Old catalog/opening/conversion records can predate the explicit type tags.
  if (/^(?:BDEF|DOP|DCL|SPL|RCB)(?:-|$)/.test(String(document.number ?? ""))) return false;
  if ([management, operation].some(value => ["yield-correction", "reconciliation", "bottle-stock", "bottle-reconciliation"].includes(value))) return true;
  return !management && !operation;
}

export function validSettlementSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
