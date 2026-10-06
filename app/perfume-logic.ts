export type PerfumeForm = "full" | "decant" | "partial" | "bottle";

export type PerfumeAllocation = {
  lotId: string;
  quantity: number;
  unitCost: number;
  warehouseId: string;
};

export type PerfumeLot = {
  id: string;
  sourceProductId: string;
  sourceProductName: string;
  originalQuantity: number;
  remainingQuantity: number;
  liquidUnitCost: number;
  /** Legacy compatibility only. New v2 lots keep bottle cost at zero because bottles are separate stock products. */
  bottleCost: number;
  /** Legacy compatibility only. New v2 lots use the liquid cost here as well. */
  landedUnitCost: number;
  /** Legacy compatibility only. New v2 liquid lots are not tied to a bottle size. */
  decantSizeMl: number | null;
  stocks: Record<string, number>;
  createdAt: string;
  conversionDocumentId: string;
  /** True when the lot was introduced as an opening balance rather than converted from on-hand full perfume stock. */
  openingBalance?: boolean;
  recombinedAt?: string | null;
  partialProductId?: string | null;
};

export function divisionLiquidCost(perfumeCost: number, divisionsCount: number) {
  if (!Number.isFinite(perfumeCost) || perfumeCost <= 0) throw new Error("invalid perfume cost");
  if (!Number.isInteger(divisionsCount) || divisionsCount <= 0) throw new Error("invalid divisions count");
  return perfumeCost / divisionsCount;
}
/** Legacy rounded helper retained for old imports/compatibility. New lots use exact division cost
 * so their total book value never exceeds the source perfume cost because of rounding. */
export function roundedDivisionLiquidCost(perfumeCost: number, divisionsCount: number) {
  return Math.ceil(divisionLiquidCost(perfumeCost, divisionsCount));
}

/** Legacy helper retained for old tests/imports. New v2 decants add bottle cost only when the sale chooses a bottle product. */
export function divisionLandedCost(perfumeCost: number, divisionsCount: number, bottleCost: number) {
  if (!Number.isFinite(bottleCost) || bottleCost < 0) throw new Error("invalid bottle cost");
  return Math.ceil(roundedDivisionLiquidCost(perfumeCost, divisionsCount) + bottleCost);
}

export function lotRemainingInWarehouse(lot: Pick<PerfumeLot, "stocks">, warehouseId: string) {
  return Number(lot.stocks?.[warehouseId] ?? 0);
}

export function lotRemainingTotal(lot: Pick<PerfumeLot, "stocks">) {
  return Object.values(lot.stocks ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}
