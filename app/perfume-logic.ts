export type PerfumeForm = "full" | "decant" | "partial";

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
  bottleCost: number;
  landedUnitCost: number;
  decantSizeMl: number | null;
  stocks: Record<string, number>;
  createdAt: string;
  conversionDocumentId: string;
  recombinedAt?: string | null;
  partialProductId?: string | null;
};

export function roundedDivisionLiquidCost(perfumeCost: number, divisionsCount: number) {
  if (!Number.isFinite(perfumeCost) || perfumeCost <= 0) throw new Error("invalid perfume cost");
  if (!Number.isInteger(divisionsCount) || divisionsCount <= 0) throw new Error("invalid divisions count");
  return Math.ceil(perfumeCost / divisionsCount);
}

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
