import type { PerfumeLot } from "./perfume-logic";

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
  const beforeRemainingQuantity = nonNegativeInteger(lot.remainingQuantity ?? 0, "الرصيد المتبقي");
  const beforeOriginalQuantity = nonNegativeInteger(lot.originalQuantity ?? 0, "الناتج الأصلي");
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
  const amount = nonNegativeInteger(quantity, "الكمية");
  if (amount <= 0) throw new Error("الكمية يجب أن تكون أكبر من صفر");
  const beforeWarehouseQuantity = nonNegativeInteger(lot.stocks?.[warehouseId] ?? 0, "رصيد المخزن");
  const beforeRemainingQuantity = nonNegativeInteger(lot.remainingQuantity ?? 0, "الرصيد المتبقي");
  if (amount > beforeWarehouseQuantity || amount > beforeRemainingQuantity) throw new Error("الكمية أكبر من رصيد الدفعة");
  const unitCost = finiteNonNegative(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0, "تكلفة التقسيمة");
  const updated: PerfumeLot = {
    ...structuredClone(lot),
    remainingQuantity: beforeRemainingQuantity - amount,
    stocks: { ...(lot.stocks ?? {}), [warehouseId]: beforeWarehouseQuantity - amount },
  };
  return {
    lot: updated,
    quantity: amount,
    unitCost,
    inventoryLoss: amount * unitCost,
    beforeWarehouseQuantity,
    afterWarehouseQuantity: beforeWarehouseQuantity - amount,
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

export function perfumeLotEquals(a: PerfumeLot, b: PerfumeLot) {
  const normalizeStocks = (stocks: Record<string, number> | undefined) =>
    Object.fromEntries(Object.entries(stocks ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({ ...a, stocks: normalizeStocks(a.stocks) }) === JSON.stringify({ ...b, stocks: normalizeStocks(b.stocks) });
}
