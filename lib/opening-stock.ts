import { StockProvenance } from "./stock-provenance.ts";
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
  const hasNativeOpening = movements.some(movement => movement.type === "opening" || movement.type === "opening-void" || String(movement.type ?? "").startsWith("opening-correction"));
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

  const provenance = new StockProvenance();
  const processedTransferRows = new Set<number>();
  const transferEffects = new Map<string, Map<string, number>>();
  let total = 0;
  let inferredCost: number | null = null;
  let firstWarehouseId: string | null = null;
  const transferLike = (type: string) => ["transfer-out","transfer-in","transfer-edit","transfer-void"].includes(type);
  const purchaseLike = (type: string) => /^(?:purchase|decant-purchase)(?:-|$)/.test(type);
  const saleLike = (type: string) => /^(?:sale|decant-sale)(?:-|$)/.test(type);
  const signedOperation = (type: string) => type === "adjustment" || type.startsWith("adjustment-") || [
    "perfume-split-out","perfume-split-in","perfume-split-void-out","perfume-split-void-in",
    "perfume-consumption-liquid","perfume-consumption-bottle","perfume-consumption-void-liquid","perfume-consumption-void-bottle",
    "perfume-stock-operation-void","perfume-stock-operation-void-bottle","perfume-opening-in","perfume-yield-correction",
    "perfume-reconciliation","perfume-reconciliation-void","perfume-recombine-out","perfume-recombine-in",
    "perfume-recombine-void-out","perfume-recombine-void-in",
  ].includes(type);

  for (let movementIndex = 0; movementIndex < movements.length; movementIndex++) {
    const movement = movements[movementIndex];
    const warehouseId = String(movement.warehouseId ?? ""), documentId = String(movement.documentId ?? "");
    const type = String(movement.type ?? ""), delta = finite(movement.quantityDelta) ?? 0;
    if (!warehouseId || !delta) continue;
    provenance.seedWarehouse(warehouseId, finite(movement.balanceBefore));
    if (type === "opening") {
      if (delta > 0) {
        provenance.add(warehouseId, delta, "opening", documentId); total += delta;
        firstWarehouseId ??= warehouseId; inferredCost = costByDocument.get(documentId) ?? inferredCost;
      } else total -= provenance.removeOpening(warehouseId, -delta);
      continue;
    }
    if (type === "opening-void" || type === "opening-correction" || type.startsWith("opening-correction-")) {
      if (delta > 0) provenance.add(warehouseId, delta, "opening", documentId);
      else provenance.removeOpening(warehouseId, -delta);
      total += delta; continue;
    }
    if (type === "legacy-opening" || purchaseLike(type)) {
      const key = type === "legacy-opening" ? "legacy:" + documentId : "purchase:" + documentId;
      if (delta > 0) provenance.add(warehouseId, delta, "other", key);
      else provenance.reverseInflow(warehouseId, -delta, key);
      continue;
    }
    if (transferLike(type)) {
      if (processedTransferRows.has(movementIndex)) continue;
      const revision = Number.isFinite(Number(movement.documentRevision)) ? Number(movement.documentRevision) : 0;
      const eventType = type === "transfer-edit" || type === "transfer-void" ? type : "transfer";
      const group: Document[] = []; let net = 0;
      // Never look ahead across a balanced event, even when historical rows lack
      // revision metadata. Business dates cannot establish mutation order.
      for (let index = movementIndex; index < movements.length; index++) {
        const candidate = movements[index], candidateType = String(candidate.type ?? "");
        const candidateRevision = Number.isFinite(Number(candidate.documentRevision)) ? Number(candidate.documentRevision) : 0;
        const candidateEvent = candidateType === "transfer-edit" || candidateType === "transfer-void" ? candidateType : "transfer";
        if (String(candidate.documentId ?? "") !== documentId || candidateRevision !== revision || !transferLike(candidateType) || candidateEvent !== eventType) break;
        group.push(candidate); processedTransferRows.add(index); net += finite(candidate.quantityDelta) ?? 0;
        if (group.length > 1 && Math.abs(net) < 1e-9) break;
      }
      const effects = new Map<string, number>();
      for (const item of group) {
        const wh = String(item.warehouseId ?? ""); provenance.seedWarehouse(wh, finite(item.balanceBefore));
        effects.set(wh, (effects.get(wh) ?? 0) + (finite(item.quantityDelta) ?? 0));
      }
      const apply = (deltas: Map<string, number>) => {
        const cargo: ReturnType<StockProvenance["withdraw"]> = [];
        for (const [wh, quantity] of deltas) if (quantity < 0) cargo.push(...provenance.withdraw(wh, -quantity));
        for (const [wh, initial] of deltas) {
          let quantity = initial; if (quantity <= 0) continue;
          for (const part of cargo) {
            const moving = Math.min(quantity, part.quantity);
            if (moving > 0) provenance.deposit(wh, [{ ...part, quantity: moving }]);
            part.quantity -= moving; quantity -= moving;
            if (quantity <= 1e-9) break;
          }
          if (quantity > 1e-9) provenance.add(wh, quantity, "other", "unattributed-transfer");
        }
      };
      const prior = transferEffects.get(documentId) ?? new Map<string, number>();
      const next = new Map(prior);
      for (const [wh, quantity] of effects) next.set(wh, (next.get(wh) ?? 0) + quantity);
      const canReversePrior = [...prior].every(([wh, quantity]) => quantity <= 0 || provenance.quantity(wh) + 1e-9 >= quantity);
      if (eventType === "transfer-edit" && prior.size && canReversePrior) {
        // A net edit can swap opening-origin and purchase-origin stock while
        // leaving its destination unchanged. Replay the recoverable old effect
        // before the new one instead of pooling unrelated source warehouses.
        apply(new Map([...prior].map(([wh, quantity]) => [wh, -quantity])));
        apply(next);
      } else apply(effects);
      transferEffects.set(documentId, new Map([...next].filter(([, quantity]) => Math.abs(quantity) > 1e-9)));
      continue;
    }
    const operationKey = (saleLike(type) ? "sale:" : signedOperation(type) ? "operation:" : "unknown:") + documentId;
    if (delta < 0) {
      const parts = provenance.withdraw(warehouseId, -delta, signedOperation(type) ? operationKey : undefined);
      provenance.remember(operationKey, String(movement.id ?? movement._id ?? ""), parts);
    } else {
      const explicit = typeof movement.reversalOfMovementId === "string" ? movement.reversalOfMovementId : undefined;
      const canRestore = Boolean(documentId && (saleLike(type) || signedOperation(type) || explicit));
      const remaining = canRestore ? provenance.restore(warehouseId, delta, operationKey, explicit) : delta;
      if (remaining > 1e-9) provenance.add(warehouseId, remaining, "other", operationKey);
    }
  }
  const allocations = provenance.openingAllocations();
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
