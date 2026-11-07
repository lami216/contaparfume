import type {SqliteDatabase as Db, SqliteSession as Session} from "../lib/sqlite.ts";
import type {PerfumeAllocation, PerfumeLot} from "./perfume-logic.ts";
import {laterLotDocuments, openSourceLots, perfumeOperationBlocked} from "./perfume-operation-guards.ts";
import {roundMl, volumeMl} from "./perfume-volume.ts";

type Row = Record<string, unknown>;
const fail = (message: string, status = 409) => Object.assign(new Error(message), {status});
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const equal = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function parseRemainderSaleInput(body: Row) {
  const productId = text(body.productId), lotId = text(body.lotId), warehouseId = text(body.warehouseId);
  if (!productId || !lotId || !warehouseId) throw fail("اختر دفعة العطر المتبقي ومخزنها", 400);
  const quantityMl = volumeMl(body.quantityMl);
  if (!["number", "string"].includes(typeof body.totalPrice) || body.totalPrice === "") throw fail("أدخل إجمالي سعر بيع المتبقي", 400);
  const price = Number(body.totalPrice), totalPrice = Math.round(price);
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(totalPrice) || totalPrice <= 0)
    throw fail("إجمالي سعر بيع المتبقي غير صالح", 400);
  return {productId, lotId, warehouseId, quantityMl, totalPrice};
}

/** The sale consumes one selected lot; no FIFO substitution, glass or new product. */
export function prepareRemainderSale(product: Row, lotId: string, warehouseId: string, quantityMl: number) {
  const {lots, lot} = remainderLot(product, lotId);
  if (lot.recombinedAt || lot.settledAt || lot.partialProductId) throw fail("الدفعة مغلقة أو أُرجع باقيها سابقًا؛ ألغِ العملية المرتبطة أولًا");
  const available = volumeMl(lot.stocks[warehouseId] ?? 0, true);
  if (available < quantityMl) throw fail("كمية بيع المتبقي أكبر من رصيد الدفعة في المخزن");
  const unitCost = Number(lot.liquidUnitCost);
  if (lot.liquidUnitCost == null || !Number.isFinite(unitCost) || unitCost < 0) throw fail("لا توجد تكلفة معتمدة للمل في هذه الدفعة");
  const before = structuredClone(lot);
  lot.stocks[warehouseId] = roundMl(available - quantityMl);
  lot.remainingQuantity = roundMl(lot.remainingQuantity - quantityMl);
  const allocation: PerfumeAllocation = {lotId, warehouseId, quantity: quantityMl, unitCost, quantityUnit: "ml"};
  return {lots, lot, before, allocations: [allocation], totalCost: quantityMl * unitCost};
}

function remainderLot(product: Row, lotId: string) {
  if (product.perfumeForm !== "decant") throw fail("اختر دفعة عطر مقسم لبيع المتبقي");
  if (product.perfumeStockUnit !== "ml") throw fail("حدد حجم التقسيمة القديمة وحوّل رصيدها إلى المل قبل بيع المتبقي");
  const lots = structuredClone(Array.isArray(product.perfumeLots) ? product.perfumeLots : []) as PerfumeLot[];
  const ids = new Set<string>(), stocks = (product.stocks ?? {}) as Row;
  for (const item of lots) {
    if (!item.id || ids.has(item.id) || item.quantityUnit !== "ml") throw fail("بيانات دفعات العطر أو وحداتها غير متطابقة؛ راجعها قبل البيع");
    ids.add(item.id);
    const total = roundMl(Object.values(item.stocks ?? {}).reduce((sum, value) => sum + volumeMl(value, true), 0));
    if (!equal(total, volumeMl(item.remainingQuantity, true))) throw fail("رصيد الدفعة لا يطابق مجموع مخازنها؛ لم يتم تغيير المخزون");
  }
  const warehouseIds = new Set([...Object.keys(stocks), ...lots.flatMap(item => Object.keys(item.stocks ?? {}))]);
  for (const warehouse of warehouseIds) {
    const total = roundMl(lots.reduce((sum, item) => sum + Number(item.stocks[warehouse] ?? 0), 0));
    if (!equal(total, volumeMl(stocks[warehouse] ?? 0, true))) throw fail("رصيد العطر لا يطابق مجموع دفعاته؛ لم يتم تغيير المخزون");
  }
  const lot = lots.find(item => item.id === lotId);
  if (!lot) throw fail("دفعة العطر المتبقي غير موجودة", 404);
  return {lots, lot};
}

/** A count is an absolute quantity decision. Reopening an older sale must not
 * silently change that decision, or reopen an exhausted lot over a newer lot. */
export async function assertRemainderSaleReversible(db: Db, session: Session, document: Row, product: Row) {
  const lines = Array.isArray(document.lines) ? document.lines as Row[] : [];
  const line = lines[0], allocations = Array.isArray(line?.perfumeAllocations) ? line.perfumeAllocations as PerfumeAllocation[] : [];
  const allocation = allocations[0], lotId = text(document.perfumeLotId), warehouseId = text(document.warehouseId);
  const quantityMl = Number(document.remainderQuantityMl), cost = Number(line?.costAtSale);
  if (lines.length !== 1 || !line || line.productId !== product.id || Number(line.quantity) !== 1 ||
      line.bottleProductId || Number(line.bottleQuantity ?? 0) !== 0 || allocations.length !== 1 || !allocation ||
      allocation.lotId !== lotId || allocation.warehouseId !== warehouseId || allocation.quantityUnit !== "ml" ||
      !Number.isFinite(quantityMl) || quantityMl <= 0 || !equal(Number(allocation.quantity), quantityMl) ||
      !equal(Number(line.liquidQuantityMl), quantityMl) || !Number.isFinite(cost) || cost < 0 ||
      !equal(cost, quantityMl * Number(allocation.unitCost)))
    throw fail("بيانات بيع المتبقي الأصلية غير متطابقة؛ لم يتم تغيير المخزون");
  const {lot} = remainderLot(product, lotId);
  const later = await laterLotDocuments(db, session, document);
  const barriers = later.filter(item => item.kind === "adjustment");
  if (barriers.length) throw perfumeOperationBlocked("ألغِ أو عدّل تسوية أو استهلاك الدفعة الأحدث قبل تعديل بيع المتبقي أو إلغائه:", barriers);
  if (Number(lot.remainingQuantity) === 0) {
    const products = await db.collection("products").find({parentProductId: lot.sourceProductId, perfumeForm: "decant"}, {session}).toArray();
    const other = openSourceLots(products, lot.sourceProductId, lot.id);
    if (other.length) {
      const all = await db.collection("documents").find({}, {session}).toArray(), anchor = all.findIndex(item => item.id === document.id);
      const ids = new Set(other.map(item => item.documentId));
      const blockers = all.filter((item, index) => item.status === "posted" && ids.has(String(item.id)) && (anchor < 0 || index > anchor));
      if (blockers.length) throw perfumeOperationBlocked("إلغاء بيع المتبقي يعيد فتح دفعة قديمة بينما توجد دفعة جديدة بها رصيد. عالج الدفعة الجديدة أولًا:", blockers);
    }
  }
}
