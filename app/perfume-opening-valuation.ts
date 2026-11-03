import { volumeMl } from "./perfume-volume.ts";
export const DEFAULT_ORIGINAL_VOLUME_ML = 100;
export type OpeningBottleCostSource = "purchase" | "opening" | "legacy-opening" | "authoritative" | "card-reference";
const positivePrice = (value: unknown) => {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
};
/** A NEW old-opened balance declares incoming liquid. Its saved card reference
 * may price that declaration without inventing a purchase or repricing history.
 * The caller supplies the normalized current cost, including an explicit null. */
export function resolveOpeningBottleCost(product: { pieceCost?: unknown; lastPurchaseCostSource?: unknown }, authoritativeCost: unknown): { cost: number | null; source: OpeningBottleCostSource | null } {
  const current = positivePrice(authoritativeCost);
  if (current !== null) {
    const source = ["purchase", "opening", "legacy-opening"].includes(String(product.lastPurchaseCostSource)) ? product.lastPurchaseCostSource as OpeningBottleCostSource : "authoritative";
    return { cost: current, source };
  }
  const reference = positivePrice(product.pieceCost);
  return reference === null ? { cost: null, source: null } : { cost: reference, source: "card-reference" };
}
/** A partial opening brings in only its remaining liquid value; it never consumes a full bottle. */
export function openingLiquidValue(bottleCost: number, remaining: unknown, original: unknown = DEFAULT_ORIGINAL_VOLUME_ML) {
  const originalVolumeMl = volumeMl(original), remainingMl = volumeMl(remaining);
  if (remainingMl > originalVolumeMl) throw Object.assign(new Error("المتبقي لا يمكن أن يتجاوز حجم العطر الأصلي"), {status:400});
  if (!Number.isFinite(bottleCost) || bottleCost <= 0) throw Object.assign(new Error("لا توجد تكلفة شراء معتمدة للعطر لحساب قيمة المتبقي"), {status:409});
  return { originalVolumeMl, remainingMl, bottleCost, remainingValue: bottleCost * remainingMl / originalVolumeMl };
}
