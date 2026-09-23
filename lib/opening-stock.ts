import type { SqliteDatabase as Db, SqliteSession as ClientSession, DbDocument as Document } from "./sqlite.ts";

const finite = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const positive = (value: unknown) => {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
};

export type OpeningStockState = {
  total: number;
  remaining: number;
  consumed: number;
  allocations: Record<string, number>;
  warehouseId: string | null;
  cost: number | null;
  hasNativeOpening: boolean;
  hasStockHistory: boolean;
  legacySnapshot: boolean;
};

function take(allocation: Record<string, number>, warehouseId: string, quantity: number) {
  const available = Math.max(0, Number(allocation[warehouseId] ?? 0));
  const used = Math.min(Math.max(0, quantity), available);
  allocation[warehouseId] = available - used;
  return used;
}
function add(allocation: Record<string, number>, warehouseId: string, quantity: number) {
  if (quantity <= 0) return;
  allocation[warehouseId] = Math.max(0, Number(allocation[warehouseId] ?? 0)) + quantity;
}

/**
 * Rebuilds native opening-stock provenance from the complete stock movement history.
 * Legacy DataAcc `legacy-opening` rows are intentionally excluded: they are imported
 * current-balance snapshots, not editable native opening balances.
 */
export async function deriveOpeningStockState(db: Db, session: ClientSession | undefined, product: Document): Promise<OpeningStockState> {
  const productId = String(product.id ?? "");
  if (!productId) return { total: 0, remaining: 0, consumed: 0, allocations: {}, warehouseId: null, cost: null, hasNativeOpening: false, hasStockHistory: false, legacySnapshot: false };
  // Replay insertion order. Edits/voids retain the invoice's original occurredAt,
  // so sorting by that date would move today's correction into the past.
  const movements = await db.collection("stockMovements").find({ productId }, { session }).toArray();
  const hasNativeOpening = movements.some(movement => movement.type === "opening" || movement.type === "opening-correction");
  const hasStockHistory = movements.length > 0;
  const legacySnapshot = movements.some(movement => movement.type === "legacy-opening") || positive(product.legacyOpeningCost) !== null;
  const openingDocumentIds = [...new Set(movements.filter(movement => movement.type === "opening").map(movement => String(movement.documentId ?? "")).filter(Boolean))];
  const openingDocuments = openingDocumentIds.length
    ? await db.collection("documents").find({ id: { $in: openingDocumentIds } }, { session }).sort({ occurredAt: 1 }).toArray()
    : [];
  const costByDocument = new Map<string, number>();
  for (const document of openingDocuments) {
    const line = (Array.isArray(document.lines) ? document.lines : []).find((item: Document) => String(item.productId ?? "") === productId);
    const cost = positive(line?.unitPrice);
    if (cost !== null) costByDocument.set(String(document.id), cost);
  }

  const allocations: Record<string, number> = {};
  const consumedBySale = new Map<string, Array<{ opening: number; other: number }>>();
  const transferredByDocument = new Map<string, number>();
  let total = 0;
  let inferredCost: number | null = null;
  let firstWarehouseId: string | null = null;

  for (const movement of movements) {
    const warehouseId = String(movement.warehouseId ?? "");
    const documentId = String(movement.documentId ?? "");
    const type = String(movement.type ?? "");
    const delta = finite(movement.quantityDelta) ?? 0;
    if (!warehouseId || !delta) continue;

    if (type === "opening") {
      // Native opening entries created by product create/update before this fix.
      if (delta > 0) {
        add(allocations, warehouseId, delta);
        total += delta;
        firstWarehouseId ??= warehouseId;
        inferredCost = costByDocument.get(documentId) ?? inferredCost;
      } else {
        const removed = take(allocations, warehouseId, -delta);
        total -= removed;
      }
      continue;
    }
    if (type === "opening-correction") {
      if (delta > 0) add(allocations, warehouseId, delta);
      else take(allocations, warehouseId, -delta);
      total += delta;
      continue;
    }
    if (type === "legacy-opening" || type === "purchase" || type === "purchase-edit" || type === "purchase-void") continue;

    if (type === "transfer-out" && delta < 0) {
      const moved = take(allocations, warehouseId, -delta);
      transferredByDocument.set(documentId, Number(transferredByDocument.get(documentId) ?? 0) + moved);
      continue;
    }
    if (type === "transfer-in" && delta > 0) {
      const pending = Math.max(0, Number(transferredByDocument.get(documentId) ?? 0));
      const moved = Math.min(delta, pending);
      add(allocations, warehouseId, moved);
      transferredByDocument.set(documentId, pending - moved);
      continue;
    }
    if ((type === "sale" || type === "sale-edit") && delta < 0) {
      const used = take(allocations, warehouseId, -delta);
      const segments = consumedBySale.get(documentId) ?? [];
      segments.push({ opening: used, other: -delta - used });
      consumedBySale.set(documentId, segments);
      continue;
    }
    if ((type === "sale-edit" || type === "sale-void") && delta > 0) {
      const segments = consumedBySale.get(documentId) ?? [];
      let returning = delta;
      // Undo the last units of this sale first: later purchase-origin units must
      // not be relabelled as opening stock when a mixed sale is reduced.
      while (returning > 0 && segments.length) {
        const segment = segments[segments.length - 1];
        const other = Math.min(returning, segment.other);
        segment.other -= other;
        returning -= other;
        const opening = Math.min(returning, segment.opening);
        segment.opening -= opening;
        returning -= opening;
        add(allocations, warehouseId, opening);
        if (!segment.opening && !segment.other) segments.pop();
      }
      continue;
    }
    // Inventory corrections and any future stock outflow consume opening units first.
    // Positive non-opening movements never create opening provenance.
    if (delta < 0) take(allocations, warehouseId, -delta);
  }

  for (const key of Object.keys(allocations)) if (allocations[key] <= 0) delete allocations[key];
  const remaining = Object.values(allocations).reduce((sum, quantity) => sum + quantity, 0);
  // Prefer explicit metadata written by the fixed workflow, but retain the complete
  // movement replay as the quantity authority for pre-fix products.
  const metadataTotal = finite(product.openingStock);
  if (metadataTotal !== null && metadataTotal >= 0 && hasNativeOpening) total = metadataTotal;
  total = Math.max(total, remaining);
  const consumed = Math.max(0, total - remaining);
  const explicitWarehouseId = typeof product.openingWarehouseId === "string" && product.openingWarehouseId ? product.openingWarehouseId : null;
  const warehouseId = explicitWarehouseId ?? Object.keys(allocations)[0] ?? firstWarehouseId;
  const cost = Object.hasOwn(product, "openingCost") ? positive(product.openingCost) : inferredCost;
  return { total, remaining, consumed, allocations, warehouseId, cost, hasNativeOpening, hasStockHistory, legacySnapshot };
}

export function planOpeningStockCorrection(state: OpeningStockState, desiredTotal: number, targetWarehouseId: string | null, relocateRemaining = false) {
  if (!Number.isInteger(desiredTotal) || desiredTotal < 0) throw new Error("رصيد البداية غير صالح");
  if (desiredTotal < state.consumed) throw new Error(`لا يمكن خفض رصيد البداية عن ${state.consumed} لأن هذه الكمية تم التصرف بها سابقًا`);
  const desiredRemaining = desiredTotal - state.consumed;
  const fallbackWarehouseId = targetWarehouseId ?? state.warehouseId ?? Object.keys(state.allocations).sort()[0] ?? null;
  if (desiredRemaining > 0 && !fallbackWarehouseId) throw new Error("مخزن رصيد البداية مطلوب");
  const desiredAllocations: Record<string, number> = {};
  if (relocateRemaining) {
    if (desiredRemaining > 0 && fallbackWarehouseId) desiredAllocations[fallbackWarehouseId] = desiredRemaining;
  } else {
    for (const [warehouseId, quantity] of Object.entries(state.allocations)) if (quantity > 0) desiredAllocations[warehouseId] = quantity;
    const change = desiredRemaining - state.remaining;
    if (change > 0 && fallbackWarehouseId) desiredAllocations[fallbackWarehouseId] = Number(desiredAllocations[fallbackWarehouseId] ?? 0) + change;
    if (change < 0) {
      let reduction = -change;
      const order = [...new Set([fallbackWarehouseId, ...Object.keys(desiredAllocations).sort()].filter((value): value is string => Boolean(value)))];
      for (const warehouseId of order) {
        if (reduction <= 0) break;
        const available = Number(desiredAllocations[warehouseId] ?? 0);
        const removed = Math.min(available, reduction);
        desiredAllocations[warehouseId] = available - removed;
        reduction -= removed;
      }
      if (reduction > 1e-9) throw new Error("تعذر مطابقة رصيد البداية مع سجل الحركات");
    }
    for (const warehouseId of Object.keys(desiredAllocations)) if (desiredAllocations[warehouseId] <= 0) delete desiredAllocations[warehouseId];
  }
  const warehouseIds = new Set([...Object.keys(state.allocations), ...Object.keys(desiredAllocations)]);
  const deltas = [...warehouseIds].map(warehouseId => ({ warehouseId, delta: Number(desiredAllocations[warehouseId] ?? 0) - Number(state.allocations[warehouseId] ?? 0) })).filter(item => item.delta !== 0);
  return { desiredRemaining, desiredAllocations, deltas };
}

export function openingFallbackCost(product: Document, state?: Pick<OpeningStockState, "cost" | "total">) {
  const opening = positive(product.openingCost) ?? (state && state.total > 0 ? positive(state.cost) : null);
  if (opening !== null) return { cost: opening, source: "opening" as const };
  const legacy = positive(product.legacyOpeningCost);
  if (legacy !== null) return { cost: legacy, source: "legacy-opening" as const };
  return { cost: null, source: null };
}
