import type { PerfumeLot } from "./perfume-logic";
import { lotQuantity, roundMl, volumeMl } from "./perfume-volume";

const finiteNonNegative = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} غير صالح`);
  return parsed;
};

const nonNegativeInteger = (value: unknown, label: string) => {
  const parsed = finiteNonNegative(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} يجب أن يكون عددًا صحيحًا`);
  return parsed;
};

function assertPerfumeLotStockBalance(lot: Pick<PerfumeLot, "remainingQuantity" | "stocks" | "quantityUnit">) {
  const remaining = lotQuantity(lot, lot.remainingQuantity ?? 0);
  const stocks = roundMl(Object.values(lot.stocks ?? {}).reduce((sum, value) => sum + lotQuantity(lot, value), 0));
  if (stocks !== remaining) throw new Error("رصيد دفعة التقسيم غير متطابق مع مجموع المخازن؛ أصلح البيانات قبل التسوية");
  return remaining;
}

export function perfumeLotBookValue(lot: Pick<PerfumeLot, "remainingQuantity" | "liquidUnitCost">) {
  const remaining = finiteNonNegative(lot.remainingQuantity, "الرصيد المتبقي");
  const unitCost = finiteNonNegative(lot.liquidUnitCost, "تكلفة التقسيمة");
  return remaining * unitCost;
}

export type YieldCorrection = {
  lot: PerfumeLot;
  beforeWarehouseQuantity: number;
  afterWarehouseQuantity: number;
  beforeRemainingQuantity: number;
  afterRemainingQuantity: number;
  beforeOriginalQuantity: number;
  afterOriginalQuantity: number;
  beforeUnitCost: number;
  afterUnitCost: number;
  remainingBookValue: number;
  quantityDelta: number;
};

/**
 * Corrects the physical yield of one perfume lot without changing the book value
 * that remains in the lot. Historical sales keep their persisted cost snapshots.
 */
export function correctPerfumeLotYield(lot: PerfumeLot, warehouseId: string, actualWarehouseQuantity: number): YieldCorrection {
  const actual = nonNegativeInteger(actualWarehouseQuantity, "الرصيد الفعلي");
  const beforeWarehouseQuantity = nonNegativeInteger(lot.stocks?.[warehouseId] ?? 0, "رصيد المخزن");
  const beforeRemainingQuantity = assertPerfumeLotStockBalance(lot);
  const beforeOriginalQuantity = nonNegativeInteger(lot.originalQuantity ?? 0, "الناتج الأصلي");
  if (beforeOriginalQuantity < beforeRemainingQuantity) throw new Error("بيانات دفعة التقسيم غير صالحة: الرصيد المتبقي أكبر من الناتج الأصلي");
  const beforeUnitCost = finiteNonNegative(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0, "تكلفة التقسيمة");
  const quantityDelta = actual - beforeWarehouseQuantity;
  const afterRemainingQuantity = beforeRemainingQuantity + quantityDelta;
  const afterOriginalQuantity = beforeOriginalQuantity + quantityDelta;
  if (afterRemainingQuantity < 0 || afterOriginalQuantity < 0) throw new Error("التصحيح يتجاوز كمية الدفعة");
  const remainingBookValue = beforeRemainingQuantity * beforeUnitCost;
  if (afterRemainingQuantity === 0 && remainingBookValue > 0) {
    throw new Error("لا يمكن تصفير دفعة لها قيمة بتصحيح الناتج؛ استخدم استهلاك/هالك التقسيمات");
  }
  const afterUnitCost = afterRemainingQuantity > 0 ? remainingBookValue / afterRemainingQuantity : 0;
  const updated: PerfumeLot = {
    ...structuredClone(lot),
    originalQuantity: afterOriginalQuantity,
    remainingQuantity: afterRemainingQuantity,
    liquidUnitCost: afterUnitCost,
    landedUnitCost: afterUnitCost,
    stocks: { ...(lot.stocks ?? {}), [warehouseId]: actual },
  };
  return {
    lot: updated,
    beforeWarehouseQuantity,
    afterWarehouseQuantity: actual,
    beforeRemainingQuantity,
    afterRemainingQuantity,
    beforeOriginalQuantity,
    afterOriginalQuantity,
    beforeUnitCost,
    afterUnitCost,
    remainingBookValue,
    quantityDelta,
  };
}

export type LotConsumption = {
  lot: PerfumeLot;
  quantity: number;
  unitCost: number;
  inventoryLoss: number;
  beforeWarehouseQuantity: number;
  afterWarehouseQuantity: number;
};

export function consumePerfumeLot(lot: PerfumeLot, warehouseId: string, quantity: number): LotConsumption {
  const amount = lotQuantity(lot, quantity);
  if (amount <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
  const beforeWarehouseQuantity = lotQuantity(lot, lot.stocks?.[warehouseId] ?? 0);
  const beforeRemainingQuantity = assertPerfumeLotStockBalance(lot);
  if (amount > beforeWarehouseQuantity || amount > beforeRemainingQuantity) throw new Error("الكمية أكبر من رصيد الدفعة");
  const unitCost = finiteNonNegative(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0, "تكلفة التقسيمة");
  const updated: PerfumeLot = {
    ...structuredClone(lot),
    remainingQuantity: roundMl(beforeRemainingQuantity - amount),
    stocks: { ...(lot.stocks ?? {}), [warehouseId]: roundMl(beforeWarehouseQuantity - amount) },
  };
  return {
    lot: updated,
    quantity: amount,
    unitCost,
    inventoryLoss: amount * unitCost,
    beforeWarehouseQuantity,
    afterWarehouseQuantity: roundMl(beforeWarehouseQuantity - amount),
  };
}

export function createOpeningPerfumeLot(input: {
  id: string;
  sourceProductId: string;
  sourceProductName: string;
  warehouseId: string;
  quantity: number;
  remainingValue: number;
  createdAt: string;
  conversionDocumentId: string;
}): PerfumeLot {
  const quantity = nonNegativeInteger(input.quantity, "الكمية الافتتاحية");
  if (quantity <= 0) throw new Error("الكمية الافتتاحية يجب أن تكون أكبر من صفر");
  const remainingValue = finiteNonNegative(input.remainingValue, "القيمة الافتتاحية");
  const liquidUnitCost = remainingValue / quantity;
  return {
    id: input.id,
    sourceProductId: input.sourceProductId,
    sourceProductName: input.sourceProductName,
    originalQuantity: quantity,
    remainingQuantity: quantity,
    liquidUnitCost,
    bottleCost: 0,
    landedUnitCost: liquidUnitCost,
    decantSizeMl: null,
    stocks: { [input.warehouseId]: quantity },
    createdAt: input.createdAt,
    conversionDocumentId: input.conversionDocumentId,
    openingBalance: true,
  };
}

export type PerfumeLotTransferAllocation = {
  lotId: string;
  quantity: number;
  unitCost: number;
  /** Missing on historical records; the lifecycle resolves it from stock evidence. */
  quantityUnit?: "piece" | "ml";
};

/** Normalize both sides of a historical allocation without rewriting its snapshot. */
export function normalizePerfumeLotTransferAllocations(lots: PerfumeLot[], allocations: PerfumeLotTransferAllocation[]) {
  const byId = new Map(lots.map(lot => [lot.id, lot]));
  return allocations.map(allocation => {
    const lot = byId.get(allocation.lotId);
    if (!lot) throw new Error("تعذر العثور على دفعة التقسيم الأصلية للتحويل");
    const sourceUnit = allocation.quantityUnit ?? "piece";
    if (sourceUnit !== "piece" && sourceUnit !== "ml") throw new Error("وحدة توزيع التحويل غير صالحة");
    if (sourceUnit === "ml" && lot.quantityUnit !== "ml") throw new Error("وحدة توزيع التحويل لا تطابق وحدة الدفعة الحالية");
    const factor = lot.quantityUnit === "ml" && sourceUnit !== "ml" ? Number(lot.legacyQuantityScaleMl) : 1;
    if (!Number.isFinite(factor) || factor <= 0) throw new Error("لا يمكن إثبات حجم التقسيمة القديمة لعكس التحويل بأمان");
    const historicalQuantity = sourceUnit === "ml" ? volumeMl(allocation.quantity) : nonNegativeInteger(allocation.quantity, "كمية توزيع التحويل");
    if (historicalQuantity <= 0) throw new Error("توزيع التحويل غير صالح");
    return { ...allocation, quantity: lotQuantity(lot, roundMl(historicalQuantity * factor), false), unitCost: finiteNonNegative(allocation.unitCost, "تكلفة التقسيمة وقت التحويل") / factor, quantityUnit: lot.quantityUnit === "ml" ? "ml" as const : "piece" as const };
  });
}

export function transferPerfumeLotStock(lots: PerfumeLot[], fromWarehouseId: string, toWarehouseId: string, quantity: number) {
  if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId) throw new Error("اختر مخزنين مختلفين");
  const ml = lots.length>0 && lots.every(lot=>lot.quantityUnit==="ml");
  const amount = ml ? volumeMl(quantity) : nonNegativeInteger(quantity, "كمية التحويل");
  if (amount <= 0) throw new Error("كمية التحويل يجب أن تكون أكبر من صفر");
  const updated = structuredClone(lots);
  for (const lot of updated) assertPerfumeLotStockBalance(lot);
  const ordered = updated
    .map((lot, index) => ({ lot, index }))
    .sort((left, right) => String(left.lot.createdAt).localeCompare(String(right.lot.createdAt)) || left.index - right.index);
  let remaining = amount;
  const allocations: PerfumeLotTransferAllocation[] = [];
  for (const { lot } of ordered) {
    if (remaining <= 0) break;
    const available = lotQuantity(lot, lot.stocks?.[fromWarehouseId] ?? 0);
    if (available <= 0) continue;
    const moved = Math.min(available, remaining);
    const target = lotQuantity(lot, lot.stocks?.[toWarehouseId] ?? 0);
    lot.stocks = { ...(lot.stocks ?? {}), [fromWarehouseId]: roundMl(available - moved), [toWarehouseId]: roundMl(target + moved) };
    allocations.push({ lotId: lot.id, quantity: moved, unitCost: finiteNonNegative(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0, "تكلفة التقسيمة"), quantityUnit: lot.quantityUnit === "ml" ? "ml" : "piece" });
    remaining = roundMl(remaining - moved);
  }
  if (remaining > 0) throw new Error("لا يمكن تحويل كمية تقسيمات أكبر من رصيد دفعات مخزن المصدر");
  return { lots: updated, allocations };
}

export function reversePerfumeLotTransfer(lots: PerfumeLot[], fromWarehouseId: string, toWarehouseId: string, allocations: PerfumeLotTransferAllocation[]) {
  if (!fromWarehouseId || !toWarehouseId || fromWarehouseId === toWarehouseId) throw new Error("مخازن التحويل غير صالحة");
  if (!Array.isArray(allocations) || allocations.length === 0) throw new Error("تحويل التقسيمات القديم لا يحتوي توزيع الدفعات اللازم لعكسه بأمان");
  const updated = structuredClone(lots);
  for (const lot of updated) assertPerfumeLotStockBalance(lot);
  const byId = new Map(updated.map(lot => [lot.id, lot]));
  for (const allocation of normalizePerfumeLotTransferAllocations(updated, allocations)) {
    const lot = byId.get(allocation.lotId);
    if (!lot) throw new Error("تعذر العثور على دفعة التقسيم الأصلية للتحويل");
    const amount = lotQuantity(lot, allocation.quantity);
    if (amount <= 0) throw new Error("توزيع التحويل غير صالح");
    const currentUnitCost = finiteNonNegative(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0, "تكلفة التقسيمة");
    const transferredUnitCost = finiteNonNegative(allocation.unitCost, "تكلفة التقسيمة وقت التحويل");
    if (Math.abs(currentUnitCost - transferredUnitCost) > 1e-9) throw new Error("لا يمكن عكس تحويل التقسيمات لأن تكلفة الدفعة تغيرت بعده. ألغِ تصحيح الناتج الأحدث أولًا");
    const destination = lotQuantity(lot, lot.stocks?.[toWarehouseId] ?? 0);
    if (destination < amount) throw new Error("لا يمكن عكس تحويل التقسيمات لأن جزءًا من الدفعة المحولة تم التصرف فيه");
    const source = lotQuantity(lot, lot.stocks?.[fromWarehouseId] ?? 0);
    lot.stocks = { ...(lot.stocks ?? {}), [toWarehouseId]: roundMl(destination - amount), [fromWarehouseId]: roundMl(source + amount) };
  }
  return updated;
}

export function perfumeLotEquals(a: PerfumeLot, b: PerfumeLot) {
  const normalizeStocks = (stocks: Record<string, number> | undefined) =>
    Object.fromEntries(Object.entries(stocks ?? {}).filter(([, value]) => Number(value) !== 0).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({ ...a, stocks: normalizeStocks(a.stocks) }) === JSON.stringify({ ...b, stocks: normalizeStocks(b.stocks) });
}
