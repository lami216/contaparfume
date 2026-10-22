import type { PerfumeLot } from "./perfume-logic";

export type PerfumeDefaults = { fillMl: number; bottleProductId: string };
export const DEFAULT_PERFUME_SETTINGS: PerfumeDefaults = { fillMl: 10, bottleProductId: "" };
export const roundMl = (value: number) => Math.round(value * 1000) / 1000;
/** Integer thousandths avoid accumulated floating-point stock drift. */
export function volumeMl(value: unknown, zero = false): number {
  if (value === "" || value == null || !["string","number"].includes(typeof value)) throw Object.assign(new Error("أدخل الحجم بالمل"),{status:400});
  const parsed = Number(value), units = Math.round(parsed * 1000);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(units) || (zero ? parsed < 0 : parsed <= 0) || Math.abs(parsed * 1000 - units) > 1e-6) throw Object.assign(new Error("الحجم غير صالح؛ استخدم حتى ثلاث منازل عشرية بالمل"),{status:400});
  return units / 1000;
}
export function lotQuantity(lot: Pick<PerfumeLot, "quantityUnit">, value: unknown, zero = true) {
  if (lot.quantityUnit === "ml") return volumeMl(value, zero);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (zero ? n < 0 : n <= 0)) throw new Error("الكمية يجب أن تكون عددًا صحيحًا");
  return n;
}
export function reconcileVolumeLot(lot: PerfumeLot, warehouseId: string, actualValue: unknown) {
  if (lot.quantityUnit !== "ml") throw new Error("حدد حجم التقسيمة القديمة قبل التسوية بالمل");
  if (lot.recombinedAt || lot.partialProductId) throw new Error("أُرجع باقي هذه الدفعة؛ ألغِ عملية الإرجاع أولًا");
  const actual = volumeMl(actualValue, true), before = volumeMl(lot.stocks[warehouseId] ?? 0, true);
  const remaining = volumeMl(lot.remainingQuantity, true);
  const total = roundMl(Object.values(lot.stocks).reduce((sum, q) => sum + volumeMl(q, true), 0));
  if (total !== remaining) throw new Error("رصيد الدفعة لا يطابق مجموع المخازن");
  const cost = Number(lot.liquidUnitCost);
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("لا توجد تكلفة معتمدة للمل في هذه الدفعة");
  const delta = roundMl(actual - before), afterRemaining = roundMl(remaining + delta);
  const updated: PerfumeLot = { ...structuredClone(lot), remainingQuantity: afterRemaining,
    stocks: { ...lot.stocks, [warehouseId]: actual },
    quantityAdjustmentMl: roundMl(Number(lot.quantityAdjustmentMl ?? 0) + delta),
    settledAt: afterRemaining === 0 ? new Date().toISOString() : null };
  return { lot: updated, before, actual, delta, unitCost: cost, inventoryLoss: Math.max(0, -delta * cost), inventoryGain: Math.max(0, delta * cost), bookValueBefore: remaining * cost, bookValueAfter: afterRemaining * cost };
}
export function lineLiquidMl(line: { quantity: number; liquidQuantityMl?: number; fillMl?: number }, product: { legacyDecantUnitMl?: number }) {
  return roundMl(line.liquidQuantityMl ?? line.quantity * (line.fillMl ?? product.legacyDecantUnitMl ?? 1));
}
export function suggestedDecantPrice(product: { piecePrice?: number | null; decantPriceBasisMl?: number }, fillMl: number) {
  return Math.round(Number(product.piecePrice ?? 0) * fillMl / Number(product.decantPriceBasisMl || 10));
}

/** Read-only normalization; legacy source movements remain unchanged on disk. */
export function presentVolumeMovement<T extends Record<string, unknown>>(row: T, product?: {perfumeStockUnit?: unknown; legacyDecantUnitMl?: unknown}) {
  if(product?.perfumeStockUnit!=="ml")return row;
  if(row.type==="perfume-unit-conversion")return {...row,quantityUnit:"ml",quantityDelta:0,balanceBefore:Number(row.balanceAfter??0)};
  if(row.quantityUnit==="ml")return row;
  const factor=Number(product.legacyDecantUnitMl??1);
  return {...row,quantityUnit:"ml",quantityDelta:roundMl(Number(row.quantityDelta??0)*factor),balanceBefore:roundMl(Number(row.balanceBefore??0)*factor),balanceAfter:roundMl(Number(row.balanceAfter??0)*factor)};
}
