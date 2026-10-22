import type { SqliteDatabase as Db, SqliteSession as Session, DbDocument as Row } from "../lib/sqlite.ts";
import type { PerfumeLot } from "./perfume-logic.ts";
import { perfumeLotEquals } from "./perfume-stock-reconciliation.ts";
import { DEFAULT_PERFUME_SETTINGS, reconcileVolumeLot, roundMl, volumeMl } from "./perfume-volume.ts";

type Delegate = (db: Db, session: Session, body: Row) => Promise<unknown>;
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const lotsOf = (product: Row): PerfumeLot[] => structuredClone(product.perfumeLots ?? []);
const doc = (title: string, warehouse: Row) => ({ id: id("adjustment"), number: `DVR-${Date.now()}-${crypto.randomUUID().slice(0,6)}`, kind: "adjustment", status: "posted", occurredAt: new Date().toISOString(), title, warehouseId: String(warehouse._id), warehouseName: warehouse.name, partyId: null, partyName: null, paymentMethod: null, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, total: 0, paidTotal: 0, dueTotal: 0, lines: [] as Row[] });
async function move(db: Db, session: Session, product: Row, warehouse: Row, delta: number, document: Row, type: string) {
  const wh = String(warehouse._id), before = Number(product.stocks?.[wh] ?? 0), after = roundMl(before + delta);
  if (after < 0) throw fail("المخزون غير كافٍ");
  await db.collection("products").updateOne({ id: product.id }, { $set: { [`stocks.${wh}`]: after } }, { session });
  product.stocks = { ...product.stocks, [wh]: after };
  await db.collection("stockMovements").insertOne({ id: id("mov"), documentId: document.id, documentNumber: document.number, warehouseId: wh, warehouseName: warehouse.name, productId: product.id, productName: product.name, type, quantityDelta: delta, balanceBefore: before, balanceAfter: after, quantityUnit: product.perfumeStockUnit === "ml" ? "ml" : "piece", occurredAt: document.occurredAt }, { session });
  return { before, after };
}

/** Reverses a count/return only while its exact lot snapshot is still current. */
export async function undoVolumeOperation(db: Db, session: Session, original: Row) {
  const product = await db.collection("products").findOne({ id: original.decantProductId }, { session });
  const warehouse = await db.collection("warehouses").findOne({ _id: original.warehouseId }, { session });
  if (!product || !warehouse) throw fail("تعذر العثور على دفعة التسوية أو مخزنها");
  const lots = lotsOf(product), index = lots.findIndex(lot => lot.id === original.perfumeLotId);
  if (index < 0 || !original.perfumeLotBefore || !original.perfumeLotAfter || !perfumeLotEquals(lots[index], original.perfumeLotAfter)) throw fail("تغيرت الدفعة بعد التسوية؛ ألغِ الحركات الأحدث أولًا");
  if (original.partialProductId) {
    const partial = await db.collection("products").findOne({ id: original.partialProductId }, { session });
    if (!partial || partial.isArchived || Number(partial.stocks?.[warehouse._id]) !== 1 || Object.values(partial.stocks ?? {}).reduce((sum: number, q) => sum + Number(q), 0) !== 1) throw fail("تم التصرف في العطر الناقص؛ ألغِ حركته الأحدث أولًا");
    await move(db, session, partial, warehouse, -1, original, "perfume-recombine-void-in");
    await db.collection("products").updateOne({ id: partial.id }, { $set: { isArchived: true, archivedAt: new Date().toISOString() } }, { session });
  }
  const before = original.perfumeLotBefore as PerfumeLot;
  const delta = roundMl(Number(before.stocks[warehouse._id] ?? 0) - Number(lots[index].stocks[warehouse._id] ?? 0));
  if (delta) await move(db, session, product, warehouse, delta, original, "perfume-reconciliation-void");
  lots[index] = structuredClone(before);
  await db.collection("products").updateOne({ id: product.id }, { $set: { perfumeLots: lots } }, { session });
  await db.collection("documents").updateOne({ id: original.id, status: "posted" }, { $set: { status: "voided", voidedAt: new Date().toISOString() } }, { session });
}

/** Called inside the existing licensed command/idempotency transaction. */
export async function handleVolumeCommand(db: Db, session: Session, body: Row, legacy: Delegate): Promise<{handled: boolean; result?: unknown}> {
  const type = String(body.type ?? "");
  if (type === "perfume-defaults.update") {
    const fillMl = volumeMl(body.fillMl), bottleProductId = String(body.bottleProductId ?? "");
    const bottle = await db.collection("products").findOne({ id: bottleProductId, perfumeForm: "bottle", isArchived: { $ne: true } }, { session });
    if (!bottle || Number(bottle.decantSizeMl) < fillMl) throw fail("اختر عبوة نشطة تتسع لحجم التعبئة الافتراضي");
    await db.collection("appSettings").updateOne({ _id: "perfume-defaults" }, { $set: { fillMl, bottleProductId, updatedAt: new Date().toISOString() } }, { session, upsert: true });
    return { handled: true, result: "perfume-defaults" };
  }
  if (type === "perfume-volume.migrate") {
    const product = await db.collection("products").findOne({ id: String(body.decantProductId), perfumeForm: "decant", isArchived: { $ne: true } }, { session });
    if (!product || product.perfumeStockUnit === "ml") throw fail("الدفعة غير موجودة أو مهيأة بالمل بالفعل");
    const factor = volumeMl(body.legacyPortionMl), before = structuredClone(product), lots = lotsOf(product);
    if (!lots.length || lots.some(lot => lot.quantityUnit === "ml")) throw fail("وحدات الدفعات غير متوافقة مع التهيئة");
    const stocks: Record<string, number> = {};
    for (const lot of lots) {
      const oldStocks = Object.values(lot.stocks).reduce((sum,q) => sum + Number(q), 0);
      if (Math.abs(oldStocks - lot.remainingQuantity) > 1e-9) throw fail("رصيد الدفعة لا يطابق المخازن");
      lot.originalQuantity = roundMl(lot.originalQuantity * factor); lot.remainingQuantity = roundMl(lot.remainingQuantity * factor);
      lot.liquidUnitCost /= factor; lot.landedUnitCost = lot.liquidUnitCost;
      lot.stocks = Object.fromEntries(Object.entries(lot.stocks).map(([wh,q]) => [wh,roundMl(q*factor)]));
      lot.quantityUnit = "ml"; lot.legacyQuantityScaleMl = factor;
      for (const [wh,q] of Object.entries(lot.stocks)) stocks[wh] = roundMl((stocks[wh] ?? 0) + q);
    }
    for (const [wh,q] of Object.entries(product.stocks ?? {})) if (Math.abs(Number(q)*factor - Number(stocks[wh] ?? 0)) > 1e-6) throw fail("مخزون المنتج لا يطابق دفعاته؛ راجع الرصيد قبل التهيئة");
    const document: Row = { id: id("adjustment"), number: `UNIT-${Date.now()}`, kind: "adjustment", status: "posted", occurredAt: new Date().toISOString(), title: "تهيئة رصيد التقسيمات بالمل", perfumeStockOperationType: "unit-conversion", quantityUnit: "ml", total: 0, paidTotal: 0, dueTotal: 0, legacyPortionMl: factor, unitConversionBefore: before, lines: [] };
    for (const [wh,actual] of Object.entries(stocks)) {
      const warehouse = await db.collection("warehouses").findOne({ _id: wh }, { session });
      if (!warehouse) { if (actual) throw fail("مخزن الدفعة غير موجود"); continue; }
      const old = Number(product.stocks?.[wh] ?? 0);
      if (actual !== old) await move(db, session, product, warehouse, roundMl(actual-old), document, "perfume-unit-conversion");
      document.lines.push({ id: id("line"), productId: product.id, description: product.name, quantity: roundMl(actual-old), unitPrice: 0, lineTotal: 0, unitConversion: true });
    }
    const values = { perfumeStockUnit: "ml", legacyDecantUnitMl: factor, decantPriceBasisMl: factor, perfumeLots: lots, stocks, pieceCost: Number(product.pieceCost ?? 0)/factor };
    await db.collection("products").updateOne({ id: product.id }, { $set: values }, { session });
    document.unitConversionAfter = { ...product, ...values };
    await db.collection("documents").insertOne(document, { session });
    return { handled: true, result: document.id };
  }
  if ((type === "perfume-split.post" || type === "perfume-opening.post") && body.volumeMl !== undefined) {
    const quantity = volumeMl(body.volumeMl), units = Math.max(type==="perfume-split.post"?2:1,Math.round(quantity*1000));
    const before = await db.collection("products").findOne({ parentProductId: String(body.sourceProductId), perfumeForm: "decant", isArchived: { $ne: true } }, { session });
    if (before && before.perfumeStockUnit !== "ml" && lotsOf(before).length) throw fail("هيئ التقسيمات القديمة بالمل من تسوية المخزون أولًا");
    const defaults = await db.collection("appSettings").findOne({ _id: "perfume-defaults" }, { session });
    const basis = volumeMl(body.priceBasisMl ?? defaults?.fillMl ?? DEFAULT_PERFUME_SETTINGS.fillMl);
    const result = await legacy(db, session, { ...body, volumeMl: undefined, divisionsCount: units, quantity: units });
    const document = await db.collection("documents").findOne({ id: String(result) }, { session });
    const incoming = document?.lines.find((line: Row) => Number(line.quantity) > 0);
    const product = incoming ? await db.collection("products").findOne({ id: incoming.productId }, { session }) : null;
    if (!document || !incoming || !product) throw fail("تعذر ربط دفعة المل بسندها");
    const lots = lotsOf(product), index = lots.findIndex(lot => lot.conversionDocumentId === document.id);
    if (index < 0) throw fail("دفعة التحويل غير موجودة");
    const lot = lots[index]; lot.originalQuantity = quantity; lot.remainingQuantity = quantity; lot.quantityUnit = "ml";
    lot.stocks = { [String(body.warehouseId)]: quantity }; lot.liquidUnitCost *= units/quantity; lot.landedUnitCost = lot.liquidUnitCost;
    const wh = String(body.warehouseId), oldStock = Number(before?.stocks?.[wh] ?? 0), newStock = roundMl(oldStock + quantity);
    await db.collection("products").updateOne({ id: product.id }, { $set: { perfumeStockUnit: "ml", perfumeLots: lots, decantPriceBasisMl: basis, pieceCost: lot.liquidUnitCost, [`stocks.${wh}`]: newStock } }, { session });
    incoming.quantity = quantity; incoming.unitPrice = lot.liquidUnitCost; incoming.balanceBefore = oldStock; incoming.balanceAfter = newStock;
    await db.collection("stockMovements").updateMany({ documentId: document.id, productId: product.id }, { $set: { quantityUnit: "ml", quantityDelta: quantity, balanceBefore: oldStock, balanceAfter: newStock } }, { session });
    await db.collection("documents").updateOne({ id: document.id }, { $set: { lines: document.lines, quantityUnit: "ml", stockDelta: quantity, perfumeLotAfter: lot } }, { session });
    if (type === "perfume-split.post") await db.collection("products").updateOne({ id: String(body.sourceProductId) }, { $set: { perfumeBottleVolumeMl: quantity } }, { session });
    return { handled: true, result };
  }
  if (type === "perfume-stock-operation.void") {
    const original = await db.collection("documents").findOne({ id: String(body.documentId), status: "posted", quantityUnit: "ml", perfumeStockOperationType: "reconciliation" }, { session });
    if (original) { await undoVolumeOperation(db,session,original); return { handled:true,result:original.id }; }
  }
  if (["perfume-split.post","perfume-opening.post"].includes(type)) {
    const existing=await db.collection("products").findOne({parentProductId:String(body.sourceProductId),perfumeForm:"decant",perfumeStockUnit:"ml",isArchived:{$ne:true}},{session});
    if(existing)throw fail("أدخل كمية العطر بالمل؛ لا يمكن إضافة عدد تقسيمات إلى رصيد بالمل");
  }
  if (!["perfume-lot-correct.post", "perfume-recombine.post"].includes(type)) return { handled: false };
  const product = await db.collection("products").findOne({ id: String(body.decantProductId), perfumeForm: "decant", isArchived: { $ne: true } }, { session });
  if (!product || product.perfumeStockUnit !== "ml") return { handled: false };
  const warehouse = await db.collection("warehouses").findOne({ _id: String(body.warehouseId), isArchived: { $ne: true } }, { session });
  if (!warehouse) throw fail("اختر مخزنًا نشطًا");
  const lots = lotsOf(product), index = lots.findIndex(lot => lot.id === body.lotId);
  if (index < 0) throw fail("الدفعة غير موجودة");
  const before = structuredClone(lots[index]), wh = String(warehouse._id), returning = type === "perfume-recombine.post";
  const actual = body.actualQuantity ?? before.stocks[wh] ?? 0;
  const count = reconcileVolumeLot(before, wh, actual);
  const reason = String(body.reason ?? "").trim();
  if (count.delta && !reason) throw fail("سبب فرق الجرد مطلوب");
  if (!returning && !count.delta && count.lot.remainingQuantity !== 0) throw fail("لا يوجد فرق في الجرد");
  if (returning && Object.entries(before.stocks).some(([key,q]) => key !== wh && q > 0)) throw fail("اجمع باقي الدفعة في مخزن واحد قبل الإرجاع");
  const document: Row = { ...doc(returning ? "إرجاع الباقي إلى عطر ناقص" : "جرد دفعة التقسيمات", warehouse), quantityUnit: "ml", perfumeStockOperationType: "reconciliation", perfumeConversionType: returning ? "perfume-recombine" : undefined, decantProductId: product.id, perfumeLotId: before.id, perfumeLotBefore: before, actualQuantity: count.actual, reconciliationDelta: count.delta, inventoryLoss: count.inventoryLoss, inventoryGain: count.inventoryGain, bookValueBefore: count.bookValueBefore, bookValueAfter: count.bookValueAfter, note: reason, stockDelta: count.delta };
  if (count.delta) {
    const balances = await move(db,session,product,warehouse,count.delta,document,"perfume-reconciliation");
    document.lines.push({ id:id("line"),productId:product.id,description:`${product.name} — فرق جرد`,quantity:count.delta,unitPrice:count.unitCost,lineTotal:0,inventoryLoss:count.inventoryLoss,inventoryGain:count.inventoryGain,balanceBefore:balances.before,balanceAfter:balances.after,perfumeRole:"count" });
  }
  lots[index] = count.lot;
  if (returning) {
    document.parentDocumentId=before.conversionDocumentId;
    const remaining = count.actual;
    if (remaining > 0) {
      const salePrice = Number(body.salePrice); if (!Number.isFinite(salePrice) || salePrice <= 0) throw fail("أدخل سعر بيع العطر الناقص");
      const skuCounter = db.collection("counters");
      const catalog=await db.collection("products").find({},{session,projection:{sku:1}}).toArray();
      const highest=catalog.reduce((max,p)=>/^\d{1,9}$/.test(String(p.sku))?Math.max(max,Number(p.sku)):max,0);
      await skuCounter.updateOne({_id:"productSequence"},{$max:{value:highest}},{session,upsert:true});
      await skuCounter.updateOne({ _id:"productSequence" },{$inc:{value:1}},{session,upsert:true});
      const next = await skuCounter.findOne({ _id:"productSequence" },{session});
      const partial: Row = { id:id("product"),sku:String(next!.value),name:`${before.sourceProductName} — ناقص ${remaining} مل`,barcode:"",pieceCost:remaining*count.unitCost,piecePrice:Math.ceil(salePrice),wholesalePrice:null,expiryDate:null,categoryId:product.categoryId??null,perfumeForm:"partial",parentProductId:before.sourceProductId,partialVolumeMl:remaining,stocks:{},createdAt:document.occurredAt };
      await db.collection("products").insertOne(partial,{session});
      await move(db,session,product,warehouse,-remaining,document,"perfume-recombine-out");
      await move(db,session,partial,warehouse,1,document,"perfume-recombine-in");
      document.partialProductId=partial.id;
      document.lines.push({id:id("line"),productId:product.id,description:product.name,quantity:-remaining,unitPrice:count.unitCost,lineTotal:0,perfumeRole:"recombine-out"},{id:id("line"),productId:partial.id,description:partial.name,quantity:1,unitPrice:partial.pieceCost,lineTotal:0,perfumeRole:"recombine-in"});
      lots[index]={...count.lot,remainingQuantity:0,stocks:{...count.lot.stocks,[wh]:0},recombinedAt:document.occurredAt,partialProductId:partial.id};
    } else lots[index]={...count.lot,settledAt:document.occurredAt};
  }
  document.perfumeLotAfter=structuredClone(lots[index]);
  await db.collection("products").updateOne({id:product.id},{$set:{perfumeLots:lots}},{session});
  await db.collection("documents").insertOne(document,{session});
  return {handled:true,result:document.id};
}
