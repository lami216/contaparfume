import { lineLiquidMl, roundMl, volumeMl } from "./perfume-volume.ts";

type BottledSaleLine = {
  productId: string;
  quantity: number;
  bottleProductId?: string | null;
  fillMl?: number;
  liquidQuantityMl?: number;
};

function blocked(message: string): never {
  throw Object.assign(new Error(message), { status: 409 });
}

function recordedVolume(line: BottledSaleLine, legacyDecantUnitMl: unknown) {
  const legacy = legacyDecantUnitMl == null ? undefined : Number(legacyDecantUnitMl);
  const fillMl = volumeMl(line.fillMl ?? (line.liquidQuantityMl == null ? legacy ?? 1 : Number(line.liquidQuantityMl) / line.quantity));
  const liquidQuantity = volumeMl(lineLiquidMl(line, { legacyDecantUnitMl: legacy }));
  if (Math.abs(roundMl(line.quantity * fillMl) - liquidQuantity) > 1e-6)
    blocked("حجم التعبئة المحفوظ لا يطابق كمية سائل الفاتورة الأصلية");
  return { fillMl, liquidQuantity };
}

/** New stock uses the registered bottle capacity. An unchanged historical
 * stock line keeps the server's saved volume, even after catalog edits. */
export function resolveBottledSaleVolume<T extends BottledSaleLine>({ product, bottle, line, historicalLines = [] }: {
  product: { perfumeStockUnit?: unknown; legacyDecantUnitMl?: unknown };
  bottle: { perfumeForm?: unknown; isArchived?: unknown; decantSizeMl?: unknown };
  line: BottledSaleLine;
  historicalLines?: readonly T[];
}): { fillMl?: number; liquidQuantity: number; historical?: T } {
  if (!line.bottleProductId || bottle.perfumeForm !== "bottle" || bottle.isArchived === true)
    blocked("زجاجة التقسيمة غير صالحة");
  if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)
    blocked("كمية زجاج التقسيمات غير صالحة");
  const ml = product.perfumeStockUnit === "ml";
  const candidates = historicalLines.filter(prior => prior.productId === line.productId
    && prior.quantity === line.quantity
    && String(prior.bottleProductId ?? "") === String(line.bottleProductId));
  let historical = candidates[0];
  if (candidates.length > 1) {
    // Old invoices could contain different fills of the same bottle. Require
    // their exact saved fill rather than guessing which allocation to replay.
    const matching = candidates.filter(prior => ml && line.fillMl != null
      && Math.abs(recordedVolume(prior, product.legacyDecantUnitMl).fillMl - line.fillMl) < 1e-6);
    if (matching.length !== 1) blocked("توجد أسطر تعبئة قديمة متشابهة؛ احتفظ بحجم كل سطر محفوظ عند تعديل الفاتورة");
    historical = matching[0];
  }
  if (historical) {
    if (!ml) return { liquidQuantity: line.quantity, historical };
    const saved = recordedVolume(historical, product.legacyDecantUnitMl);
    if (line.fillMl != null && Math.abs(volumeMl(line.fillMl) - saved.fillMl) > 1e-6)
      blocked("حجم التعبئة المحفوظ لا يمكن تغييره؛ غيّر الزجاجة أو الكمية لاستخدام سعة الزجاجة المسجلة");
    return { ...saved, historical };
  }
  // Unmigrated catalogs count old portions, not millilitres. Requiring a new
  // capacity here would strand their otherwise valid legacy invoices.
  if (!ml) return { liquidQuantity: line.quantity };
  let capacity: number;
  try { capacity = volumeMl(bottle.decantSizeMl); }
  catch { return blocked("حدد سعة زجاجة التقسيمة المسجلة بالمل أولًا"); }
  if (line.fillMl != null && Math.abs(volumeMl(line.fillMl) - capacity) > 1e-6)
    blocked("حجم التعبئة يجب أن يطابق سعة الزجاجة المسجلة");
  return { fillMl: capacity, liquidQuantity: volumeMl(roundMl(line.quantity * capacity)) };
}
