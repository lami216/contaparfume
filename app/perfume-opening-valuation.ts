import { volumeMl } from "./perfume-volume.ts";
export const DEFAULT_ORIGINAL_VOLUME_ML = 100;
/** A partial opening brings in only its remaining liquid value; it never consumes a full bottle. */
export function openingLiquidValue(bottleCost: number, remaining: unknown, original: unknown = DEFAULT_ORIGINAL_VOLUME_ML) {
  const originalVolumeMl = volumeMl(original), remainingMl = volumeMl(remaining);
  if (remainingMl > originalVolumeMl) throw Object.assign(new Error("المتبقي لا يمكن أن يتجاوز حجم العطر الأصلي"), {status:400});
  if (!Number.isFinite(bottleCost) || bottleCost <= 0) throw Object.assign(new Error("لا توجد تكلفة شراء معتمدة للعطر لحساب قيمة المتبقي"), {status:409});
  return { originalVolumeMl, remainingMl, bottleCost, remainingValue: bottleCost * remainingMl / originalVolumeMl };
}
