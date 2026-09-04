import { requireValidLicense } from "../../../lib/license.ts";
import type { SqliteSession as ClientSession, SqliteDatabase as Db } from "../../../lib/sqlite.ts";
import { getDatabase } from "../../../lib/sqlite.ts";
import { log } from "../../../lib/log.ts";
import { requireCapability, validSameOrigin, type Capability } from "../../../lib/auth.ts";
import { isProductExpired } from "../../domain.ts";
import { normalizePartyNet, partyCashDelta, partyNet } from "../../party-balance.ts";
import { nextDocumentSequence, type SequencedDocumentKind } from "../../../lib/document-sequences.ts";

type Input = Record<string, unknown>;
type Line = { id?: string; productId: string; quantity: number; description?: string; piecePrice?: number; unitPrice?: number; actualQuantity?: number; purchaseCost?: number | null; costAtSale?: number | null; grossProfit?: number | null };
type WarehouseDoc = { _id: string; name: string; isSalesDefault?: boolean; [key: string]: unknown };
const warehouses = (db: Db) => db.collection<WarehouseDoc>("warehouses");
class CommandError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const num = (v: unknown) => typeof v === "number" ? v : Number(v);
const positive = (v: unknown, label: string, allowZero = false) => {
  const n = num(v); if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) throw new CommandError(`${label} غير صالح`); return n;
};
const optionalNumber = (v: unknown, label: string, integer = false) => {
  if (v === "" || v == null) return null;
  const n = positive(v, label, true);
  if (integer && (!Number.isInteger(n) || n <= 0)) throw new CommandError(`${label} غير صالح`);
  return n;
};
const optionalDate = (value: unknown) => {
  const date = text(value);
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new CommandError("تاريخ انتهاء الصلاحية غير صالح");
  return date;
};
async function nextProductCode(db: Db, session: ClientSession) {
  const counters = db.collection<{ _id: string; value: number; createdAt?: Date; updatedAt?: Date }>("counters");
  const legacy = await db.collection("products").find(
    { sku: { $type: "string", $regex: /^\d{1,6}$/ } }, { session, projection: { sku: 1 } },
  ).toArray();
  const highest = legacy.reduce((value, product) => Math.max(value, Number(product.sku)), 0);
  await counters.updateOne(
    { _id: "productSequence" }, { $max: { value: highest }, $setOnInsert: { createdAt: new Date() } }, { upsert: true, session },
  );
  const counter = await counters.findOneAndUpdate(
    { _id: "productSequence" }, { $inc: { value: 1 }, $set: { updatedAt: new Date() } }, { returnDocument: "after", session },
  );
  if (!counter) throw new CommandError("تعذر توليد رمز المنتج", 409);
  return String(counter.value);
}
const lines = (body: Input): Line[] => {
  if (!Array.isArray(body.lines) || !body.lines.length) throw new CommandError("يجب إضافة منتج واحد على الأقل");
  const seen = new Set<string>();
  return body.lines.map((raw) => {
    const r = raw as Input, productId = text(r.productId), quantity = positive(r.quantity, "الكمية");
    if (!productId || seen.has(productId)) throw new CommandError("المنتجات غير صالحة أو مكررة"); seen.add(productId);
    return { productId, quantity, piecePrice: num(r.piecePrice), unitPrice: num(r.unitPrice), actualQuantity: num(r.actualQuantity) };
  });
};
const baseDocument = (kind: string, prefix: string) => ({
  id: id(kind), number: `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, kind, status: "posted", occurredAt: new Date().toISOString(),
});
async function numberedDocument(db: Db, session: ClientSession, kind: SequencedDocumentKind, prefix: string) {
  return { ...baseDocument(kind, prefix), sequence: await nextDocumentSequence(db, kind, session) };
}
async function paymentAccount(db: Db, session: ClientSession, value: unknown, active = true) {
  const key = text(value);
  const account = await db.collection("paymentAccounts").findOne({ $or: [{ id: key }, { code: key }], ...(active ? { isActive: true, isArchived: { $ne: true } } : {}) }, { session });
  if (!account) throw new CommandError("يجب اختيار وسيلة دفع صالحة");
  return account;
}
async function financialMovement(db: Db, session: ClientSession, document: Record<string, unknown>, direction: "in" | "out", amount: number, type: string) {
  if (!amount) return;
  const account = await paymentAccount(db, session, document.paymentMethod);
  const delta = direction === "in" ? amount : -amount;
  const result = await db.collection("paymentAccounts").updateOne(
    { id: account.id },
    { $inc: { balance: delta } }, { session },
  );
  if (!result.matchedCount) throw new CommandError(`الرصيد غير كافٍ في ${account.name}`);
  await db.collection("financialMovements").insertOne({ id: id("fin"), paymentMethod: account.id, paymentCode: account.code, direction, amount, documentId: document.id, documentNumber: document.number, partyId: document.partyId ?? null, partyName: document.partyName ?? null, type, occurredAt: document.occurredAt, transferId: document.transferId ?? null, note: document.note ?? null }, { session });
}
async function authoritativeCost(db: Db, session: ClientSession, product: Record<string, unknown>) {
  if (Number.isFinite(product.lastPurchaseCost)) return Number(product.lastPurchaseCost);
  const latest = await db.collection("documents").findOne({ kind: "purchase", status: "posted", "lines.productId": product.id }, { session, sort: { occurredAt: -1 }, projection: { lines: 1, occurredAt: 1 } });
  const line = (latest?.lines as Line[] | undefined)?.find(item => item.productId === product.id);
  if (!line || !Number.isFinite(Number(line.unitPrice))) return null;
  const cost = Number(line.unitPrice);
  await db.collection("products").updateOne({ id: product.id, lastPurchaseCost: { $exists: false } }, { $set: { lastPurchaseCost: cost, lastPurchaseAt: latest?.occurredAt } }, { session });
  product.lastPurchaseCost = cost;
  return cost;
}
async function historicalCost(db: Db, session: ClientSession, productId: string, occurredAt: string) {
  const purchase = await db.collection("documents").findOne(
    { kind: "purchase", status: "posted", occurredAt: { $lte: occurredAt }, "lines.productId": productId },
    { session, sort: { occurredAt: -1 } },
  );
  const line = (purchase?.lines as Line[] | undefined)?.find(item => item.productId === productId);
  return line && Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : null;
}
async function changePartyDebt(db: Db, session: ClientSession, partyId: unknown, kind: "sale" | "purchase", delta: number, reversing = false) {
  if (!delta) return;
  await applyPartyNetDelta(db, session, partyId, kind === "sale" ? delta : -delta, reversing);
}
async function applyPartyNetDelta(db: Db, session: ClientSession, partyId: unknown, delta: number, reversing = false) {
  const party = await db.collection("parties").findOne({ id: String(partyId) }, { session });
  if (!party) { if (reversing) throw new CommandError("لا يمكن تعديل رصيد الطرف", 409); return null; }
  const before = partyNet(party as {receivable?:unknown;payable?:unknown});
  // Invoice corrections reconcile against the current net ledger. Independent party
  // settlements remain historical facts, so reversing an invoice may cross zero.
  const after = before + delta;
  await db.collection("parties").updateOne({ _id: party._id }, { $set: { ...normalizePartyNet(after), lastMovementAt: new Date() } }, { session });
  return { before, delta, after };
}
async function reverseInvoicePayment(db: Db, session: ClientSession, document: Record<string, unknown>, kind: "sale" | "purchase") {
  const amount = Number(document.cashAmount ?? document.paidTotal ?? 0);
  if (!amount) return;
  const movement = await db.collection("financialMovements").findOne({ documentId: document.id, type: kind }, { session });
  if (!movement) throw new CommandError("تعذر العثور على حركة الدفع الأصلية للفاتورة", 409);
  const account = await paymentAccount(db, session, movement.paymentMethod, false);
  // Reversals correct posted history and may make a balance negative; this is not a new discretionary outflow.
  await db.collection("paymentAccounts").updateOne({ id: account.id }, { $inc: { balance: kind === "sale" ? -amount : amount } }, { session });
  await db.collection("financialMovements").deleteOne({ _id: movement._id }, { session });
}
async function recomputePurchaseCosts(db: Db, session: ClientSession, productIds: string[]) {
  for (const productId of new Set(productIds)) {
    const latest = await db.collection("documents").findOne(
      { kind: "purchase", status: "posted", "lines.productId": productId }, { session, sort: { occurredAt: -1 } },
    );
    const line = (latest?.lines as Line[] | undefined)?.find(item => item.productId === productId);
    await db.collection("products").updateOne({ id: productId }, { $set: { lastPurchaseCost: line ? Number(line.unitPrice) : null, lastPurchaseAt: latest?.occurredAt ?? null } }, { session });
  }
}
async function refs(db: Db, session: ClientSession, body: Input, requireParty = false) {
  const warehouseId = text(body.warehouseId), partyId = text(body.partyId);
  const [warehouse, party] = await Promise.all([
    warehouseId ? warehouses(db).findOne({ _id: warehouseId, isArchived: { $ne: true } }, { session }) : null,
    partyId ? db.collection("parties").findOne({ id: partyId }, { session }) : null,
  ]);
  if (!warehouse) throw new CommandError("المخزن غير موجود", 404);
  if (requireParty && !party) throw new CommandError("الطرف غير موجود", 404);
  return { warehouse, party, warehouseId, partyId };
}
async function products(db: Db, session: ClientSession, input: Line[]) {
  const found = await db.collection("products").find({ id: { $in: input.map(x => x.productId) }, isArchived: { $ne: true } }, { session }).toArray();
  if (found.length !== input.length) throw new CommandError("أحد المنتجات غير موجود", 404);
  return new Map(found.map(p => [p.id as string, p]));
}
async function changeStock(db: Db, session: ClientSession, product: Record<string, unknown>, warehouse: Record<string, unknown>, delta: number, document: Record<string, unknown>, type: string) {
  const warehouseId = String(warehouse._id), productId = String(product.id), before = Number((product.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0), after = before + delta;
  if (after < 0) throw new CommandError(`المخزون غير كافٍ للمنتج ${product.name}`);
  const stockPath = `stocks.${warehouseId}`;
  const stockMatch = before === 0 ? { $or: [{ [stockPath]: 0 }, { [stockPath]: { $exists: false } }] } : { [stockPath]: before };
  const result = await db.collection("products").updateOne({ id: productId, ...stockMatch }, { $set: { [stockPath]: after } }, { session });
  if (!result.matchedCount) throw new CommandError("تغير المخزون أثناء العملية، أعد المحاولة", 409);
  const currentStocks = (product.stocks ??= {}) as Record<string, number>;
  currentStocks[warehouseId] = after;
  await db.collection("stockMovements").insertOne({ id: id("mov"), documentId: document.id, documentNumber: document.number, warehouseId, warehouseName: warehouse.name, productId, productName: product.name, type, quantityDelta: delta, balanceBefore: before, balanceAfter: after, occurredAt: document.occurredAt }, { session });
  return { before, after };
}

export async function execute(db: Db, session: ClientSession, body: Input) {
  const type = text(body.type);
  if (type === "product.delete") {
    const productId = text(body.id), product = await db.collection("products").findOne({ id: productId }, { session });
    if (!product) throw new CommandError("المنتج غير موجود", 404);
    await db.collection("products").updateOne({ id: productId }, { $set: { isArchived: true, archivedAt: new Date() } }, { session });
    return productId;
  }
  if (type === "product.restore") {
    const productId=text(body.id),result=await db.collection("products").updateOne({id:productId,isArchived:true},{$set:{isArchived:false,archivedAt:null}},{session});
    if(!result.matchedCount)throw new CommandError("المنتج المحذوف غير موجود",404);return productId;
  }
  if (type === "party.create") {
    const name = text(body.name), phone = text(body.phone), partyType = text(body.partyType); if (!name) throw new CommandError("اسم الحساب مطلوب");
    if (!["customer", "supplier"].includes(partyType)) throw new CommandError("نوع الحساب غير صالح");
    if (phone) { const existing = await db.collection("parties").findOne({ phone, partyType }, { session }); if (existing) return String(existing.id); }
    const party = { id: id("party"), name, phone, partyType, receivable: 0, payable: 0, net: 0, createdAt: new Date() };
    await db.collection("parties").insertOne(party, { session }); return party.id;
  }
  if (type === "warehouse.create") {
    const name = text(body.name); if (!name) throw new CommandError("اسم المخزن مطلوب"); const _id = id("wh");
    await warehouses(db).insertOne({ _id, name, isSalesDefault: false, createdAt: new Date() }, { session }); return _id;
  }
  if (type === "warehouse.update") { const name = text(body.name), warehouseId = text(body.id); if (!name) throw new CommandError("اسم المخزن مطلوب"); const r = await warehouses(db).updateOne({ _id: warehouseId }, { $set: { name } }, { session }); if (!r.matchedCount) throw new CommandError("المخزن غير موجود", 404); return warehouseId; }
  if (type === "warehouse.default") { const warehouseId = text(body.warehouseId); if (!await warehouses(db).findOne({ _id: warehouseId, isArchived: { $ne: true } }, { session })) throw new CommandError("المخزن غير موجود", 404); await warehouses(db).updateMany({}, { $set: { isSalesDefault: false } }, { session }); await warehouses(db).updateOne({ _id: warehouseId }, { $set: { isSalesDefault: true } }, { session }); return warehouseId; }
  if (type === "warehouse.delete") {
    const warehouseId=text(body.id), warehouse=await warehouses(db).findOne({_id:warehouseId},{session}); if(!warehouse)throw new CommandError("المخزن غير موجود",404);
    if(warehouse.isSalesDefault)throw new CommandError("عيّن مخزنًا آخر للبيع قبل حذف هذا المخزن",409);
    if(await db.collection("products").findOne({[`stocks.${warehouseId}`]:{$exists:true,$ne:0}},{session}))throw new CommandError("لا يمكن حذف مخزن يحتوي على مخزون",409);
    const referenced=await db.collection("documents").findOne({$or:[{warehouseId},{destinationWarehouseId:warehouseId}]},{session})||await db.collection("stockMovements").findOne({warehouseId},{session});
    if(referenced)await warehouses(db).updateOne({_id:warehouseId},{$set:{isArchived:true,archivedAt:new Date(),isSalesDefault:false}},{session});else await warehouses(db).deleteOne({_id:warehouseId},{session}); return warehouseId;
  }
  if (type === "product.create" || type === "product.update") {
    const name = text(body.name), barcode = text(body.barcode);
    if (!name) throw new CommandError("اسم المنتج مطلوب");
    const productId = text(body.id);
    if (barcode && await db.collection("products").findOne({ barcode, ...(type === "product.update" ? { id: { $ne: productId } } : {}) }, { session })) throw new CommandError("هذا الباركود مستخدم لمنتج آخر", 409);
    const note = text(body.note);
    if (note.length > 1000) throw new CommandError("ملاحظة المنتج طويلة جدًا");
    const pieceCost = optionalNumber(body.pieceCost, "سعر الشراء"), values = { name, barcode, expiryDate: optionalDate(body.expiryDate), note: note || null, pieceCost, piecePrice: optionalNumber(body.piecePrice, "سعر البيع"), wholesalePrice: optionalNumber(body.wholesalePrice, "سعر الجملة") };
    if (type === "product.create") {
      const openingStock = optionalNumber(body.openingStock, "رصيد البداية") ?? 0;
      if (!Number.isInteger(openingStock)) throw new CommandError("رصيد البداية غير صالح");
      if (openingStock > 0 && (!pieceCost || pieceCost <= 0)) throw new CommandError("سعر الشراء للفرد مطلوب عند إدخال رصيد بداية");
      let warehouse = null;
      if (openingStock > 0) {
        const openingWarehouseId = text(body.openingWarehouseId);
        if (!openingWarehouseId) throw new CommandError("مخزن رصيد البداية مطلوب");
        warehouse = await warehouses(db).findOne({ _id: openingWarehouseId, isArchived: { $ne: true } }, { session });
        if (!warehouse) throw new CommandError("مخزن رصيد البداية مطلوب");
      }
      const sku = await nextProductCode(db, session), now = new Date(), product = { id: id("product"), sku, ...values, ...(openingStock > 0 ? { lastPurchaseCost: pieceCost, lastPurchaseAt: now.toISOString() } : {}), stocks: {}, createdAt: now };
      await db.collection("products").insertOne(product, { session });
      if (openingStock > 0 && warehouse) {
        const doc = { ...baseDocument("adjustment", "OPEN"), partyId: null, partyName: null, warehouseId: warehouse._id, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: null, title: "رصيد بداية", total: 0, dueTotal: 0, paidTotal: 0, lines: [{ id: id("line"), productId: product.id, description: name, quantity: openingStock, unitPrice: pieceCost, lineTotal: 0 }] };
        await changeStock(db, session, product, warehouse, openingStock, doc, "opening");
        await db.collection("documents").insertOne(doc, { session });
      }
      return product.id;
    }
    const product=await db.collection("products").findOne({id:productId},{session}); if(!product)throw new CommandError("المنتج غير موجود",404);
    const openingStock=optionalNumber(body.openingStock,"رصيد البداية")??0; if(!Number.isInteger(openingStock))throw new CommandError("رصيد البداية غير صالح");
    let openingWarehouse=null; if(openingStock>0){if(!pieceCost||pieceCost<=0)throw new CommandError("سعر الشراء للفرد مطلوب عند إدخال رصيد بداية"); openingWarehouse=await warehouses(db).findOne({_id:text(body.openingWarehouseId),isArchived:{$ne:true}},{session});if(!openingWarehouse)throw new CommandError("مخزن رصيد البداية مطلوب");}
    await db.collection("products").updateOne({id:productId},{$set:values},{session});
    if(openingStock>0&&openingWarehouse){const doc={...baseDocument("adjustment","OPEN"),partyId:null,partyName:null,warehouseId:openingWarehouse._id,warehouseName:openingWarehouse.name,destinationWarehouseId:null,destinationWarehouseName:null,parentDocumentId:null,paymentMethod:null,title:"إضافة رصيد افتتاحي",total:0,dueTotal:0,paidTotal:0,lines:[{id:id("line"),productId,description:name,quantity:openingStock,unitPrice:pieceCost,lineTotal:0}]};await changeStock(db,session,product,openingWarehouse,openingStock,doc,"opening");await db.collection("documents").insertOne(doc,{session});}
    return productId;
  }
  if (["sale.update", "purchase.update"].includes(type)) {
    const kind = type.startsWith("sale") ? "sale" : "purchase", isSale = kind === "sale", documentId = text(body.documentId);
    const original = await db.collection("documents").findOne({ id: documentId, kind, status: "posted" }, { session });
    if (!original) throw new CommandError("الفاتورة غير موجودة أو غير قابلة للتعديل", 404);
    if (original.legacyKey) throw new CommandError("الفواتير المرحلة متاحة للعرض فقط", 409);
    if (isSale && await db.collection("documents").findOne({ kind: "return", status: "posted", parentDocumentId: documentId }, { session })) throw new CommandError("لا يمكن تعديل هذه الفاتورة القديمة لوجود حركة تاريخية مرتبطة بها.", 409);
    const input = lines(body), paymentMethod = text(body.paymentMethod);
    const { warehouse, party, warehouseId, partyId } = await refs(db, session, { ...body, warehouseId: isSale ? original.warehouseId : body.warehouseId }, paymentMethod === "note");
    if (party && party.partyType !== (isSale ? "customer" : "supplier")) throw new CommandError(isSale ? "يجب اختيار عميل صالح" : "يجب اختيار مورد صالح");
    if (paymentMethod !== "note") await paymentAccount(db, session, paymentMethod);
    const newProducts = await products(db, session, input), oldLines = original.lines as Line[], oldByProduct = new Map(oldLines.map(line => [line.productId, line]));
    if (isSale && input.some(line => isProductExpired(newProducts.get(line.productId)!, String(original.businessDate ?? String(original.occurredAt).slice(0, 10))))) throw new CommandError("انتهت صلاحية هذا المنتج ولا يمكن بيعه.");
    const calculated = [] as Record<string, unknown>[];
    for (const line of input) {
      const product = newProducts.get(line.productId)!, old = oldByProduct.get(line.productId);
      const unitPrice = positive(isSale ? line.piecePrice : line.unitPrice, isSale ? "سعر الفرد" : "سعر الشراء"), lineTotal = Math.round(line.quantity * unitPrice);
      if (isSale) {
        const cost = old ? old.costAtSale ?? null : await historicalCost(db, session, line.productId, String(original.occurredAt));
        calculated.push({ id: old?.id ?? id("line"), productId: line.productId, description: product.name, quantity: line.quantity, unitPrice, lineTotal, costAtSale: cost, grossProfit: cost == null ? null : lineTotal - line.quantity * Number(cost) });
      } else calculated.push({ id: old?.id ?? id("line"), productId: line.productId, description: product.name, quantity: line.quantity, unitPrice, lineTotal });
    }
    const total = calculated.reduce((sum, line) => sum + Number(line.lineTotal), 0), paidTotal = paymentMethod === "note" ? 0 : total, dueTotal = total - paidTotal;
    if (dueTotal && !party) throw new CommandError(isSale ? "اختر عميلاً عند وجود مبلغ مستحق" : "اختر موردًا عند وجود مبلغ مستحق");
    const oldWarehouse = await warehouses(db).findOne({ _id: String(original.warehouseId) }, { session });
    if (!oldWarehouse) throw new CommandError("مخزن الفاتورة الأصلي غير موجود", 409);
    const allIds = [...new Set([...oldLines.map(line => line.productId), ...input.map(line => line.productId)])], allProducts = await db.collection("products").find({ id: { $in: allIds } }, { session }).toArray(), productMap = new Map(allProducts.map(product => [String(product.id), product]));
    if (productMap.size !== allIds.length) throw new CommandError("أحد منتجات الفاتورة لم يعد موجودًا", 409);
    const newByProduct = new Map(input.map(line => [line.productId, line.quantity]));
    if (!isSale && warehouseId !== String(original.warehouseId)) {
      for (const old of oldLines) try { await changeStock(db, session, productMap.get(old.productId)!, oldWarehouse, -old.quantity, original, "purchase-edit"); } catch (error) { if (error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن تعديل الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
      for (const line of input) await changeStock(db, session, productMap.get(line.productId)!, warehouse, line.quantity, original, "purchase-edit");
    } else {
      const oldQuantity = new Map(oldLines.map(line => [line.productId, line.quantity]));
      for (const productId of allIds) {
        const delta = isSale ? (oldQuantity.get(productId) ?? 0) - (newByProduct.get(productId) ?? 0) : (newByProduct.get(productId) ?? 0) - (oldQuantity.get(productId) ?? 0);
        if (!delta) continue;
        try { await changeStock(db, session, productMap.get(productId)!, warehouse, delta, original, `${kind}-edit`); } catch (error) { if (!isSale && error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن تعديل الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
      }
    }
    if (Number(original.dueTotal) > 0) await changePartyDebt(db, session, original.partyId, kind, -Number(original.dueTotal), true);
    await reverseInvoicePayment(db, session, original, kind);
    const partyEffect = party ? (isSale ? dueTotal : -dueTotal) : 0;
    const snapshot = party ? await applyPartyNetDelta(db, session, partyId, partyEffect) : null;
    const revised = { partyId: partyId || null, partyName: party?.name ?? (isSale ? "بيع مباشر" : "شراء مباشر"), warehouseId, warehouseName: warehouse.name, paymentMethod, total, paidTotal, cashAmount: paidTotal, dueTotal, lines: calculated, ...(snapshot ? { partyBalanceBefore: snapshot.before, partyBalanceDelta: snapshot.delta, partyBalanceAfter: snapshot.after } : {}), ...(isSale ? { pricingMode: body.pricingMode === "wholesale" ? "wholesale" : "retail" } : {}), updatedAt: new Date(), revision: Number(original.revision ?? 0) + 1 };
    await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: revised, ...(!snapshot ? { $unset: { partyBalanceBefore: "", partyBalanceDelta: "", partyBalanceAfter: "" } } : {}) }, { session });
    if (paidTotal) await financialMovement(db, session, { ...original, ...revised }, isSale ? "in" : "out", paidTotal, kind);
    if (!isSale) await recomputePurchaseCosts(db, session, allIds);
    return documentId;
  }
  if (["sale.void", "purchase.void"].includes(type)) {
    const kind = type.startsWith("sale") ? "sale" : "purchase", isSale = kind === "sale", documentId = text(body.documentId);
    const original = await db.collection("documents").findOne({ id: documentId, kind, status: "posted" }, { session });
    if (!original) throw new CommandError("الفاتورة غير موجودة أو ملغاة بالفعل", 404);
    if (original.legacyKey) throw new CommandError("الفواتير المرحلة متاحة للعرض فقط", 409);
    if (isSale && await db.collection("documents").findOne({ kind: "return", status: "posted", parentDocumentId: documentId }, { session })) throw new CommandError("لا يمكن حذف هذه الفاتورة القديمة لوجود حركة تاريخية مرتبطة بها.", 409);
    const warehouse = await warehouses(db).findOne({ _id: String(original.warehouseId) }, { session });
    if (!warehouse) throw new CommandError("مخزن الفاتورة غير موجود", 409);
    const oldLines = original.lines as Line[], found = await db.collection("products").find({ id: { $in: oldLines.map(line => line.productId) } }, { session }).toArray(), map = new Map(found.map(product => [String(product.id), product]));
    for (const line of oldLines) try { await changeStock(db, session, map.get(line.productId)!, warehouse, isSale ? line.quantity : -line.quantity, original, `${kind}-void`); } catch (error) { if (!isSale && error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن حذف الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
    if (Number(original.dueTotal) > 0) await changePartyDebt(db, session, original.partyId, kind, -Number(original.dueTotal), true);
    await reverseInvoicePayment(db, session, original, kind);
    await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date() } }, { session });
    if (!isSale) await recomputePurchaseCosts(db, session, oldLines.map(line => line.productId));
    return documentId;
  }
  if (type === "sale.post" || type === "purchase.post") {
    const input = lines(body), isSale = type === "sale.post", { warehouse, party, warehouseId, partyId } = await refs(db, session, body, text(body.paymentMethod) === "note"), map = await products(db, session, input), paymentMethod = text(body.paymentMethod);
    if (party && party.partyType !== (isSale ? "customer" : "supplier")) throw new CommandError(isSale ? "يجب اختيار عميل صالح" : "يجب اختيار مورد صالح");
    if (isSale && input.some(line => isProductExpired(map.get(line.productId)!, new Date().toISOString().slice(0, 10)))) throw new CommandError("انتهت صلاحية هذا المنتج ولا يمكن بيعه.");
    if (paymentMethod !== "note") await paymentAccount(db, session, paymentMethod);
    const costs = isSale ? new Map(await Promise.all(input.map(async line => [line.productId, await authoritativeCost(db, session, map.get(line.productId)!)] as const))) : new Map<string, number | null>();
    const calculated = input.map(line => { const p = map.get(line.productId)!; let unitPrice: number, total: number; if (isSale) { const price = positive(line.piecePrice, "سعر الفرد"); total = Math.round(line.quantity * price); unitPrice = price; } else { unitPrice = positive(line.unitPrice, "سعر الشراء"); total = Math.round(unitPrice * line.quantity); } return { id: id("line"), productId: line.productId, description: p.name, quantity: line.quantity, unitPrice, lineTotal: total, ...(isSale ? { costAtSale: costs.get(line.productId) ?? null, grossProfit: costs.get(line.productId) == null ? null : total - line.quantity * Number(costs.get(line.productId)) } : {}) }; });
    const total = calculated.reduce((s, l) => s + l.lineTotal, 0), cashAmount = paymentMethod === "note" ? 0 : positive(body.cashAmount ?? body.paidAmount ?? total, isSale ? "المبلغ المستلم" : "المبلغ المدفوع", true), requestedPaid = Math.min(total, cashAmount), due = Math.max(total - cashAmount, 0), partyDelta = isSale ? total - cashAmount : -total + cashAmount;
    if (partyDelta && !party) throw new CommandError(isSale ? "اختر عميلاً عند وجود مبلغ مستحق" : "اختر موردًا عند وجود مبلغ مستحق");
    const businessDate = new Date().toISOString().slice(0, 10);
    const dailySequence = isSale ? (Number((await db.collection("documents").find({ kind: "sale", businessDate }, { session }).sort({ dailySequence: -1 }).limit(1).next())?.dailySequence ?? 0) + 1) : undefined;
    const pricingMode = body.pricingMode === "wholesale" ? "wholesale" : "retail";
    const snapshot = partyDelta ? await applyPartyNetDelta(db, session, partyId, partyDelta) : null;
    const doc = { ...await numberedDocument(db, session, isSale ? "sale" : "purchase", isSale ? "SAL" : "PUR"), businessDate, ...(isSale ? { dailySequence, pricingMode } : {}), partyId: partyId || null, partyName: party?.name ?? (isSale ? "بيع مباشر" : "شراء مباشر"), warehouseId, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod, title: null, total, dueTotal: due, paidTotal: requestedPaid, cashAmount, ...(snapshot ? { partyBalanceBefore:snapshot.before, partyBalanceDelta:snapshot.delta, partyBalanceAfter:snapshot.after } : {}), lines: calculated };
    for (const line of input) await changeStock(db, session, map.get(line.productId)!, warehouse, isSale ? -line.quantity : line.quantity, doc, isSale ? "sale" : "purchase");
    await db.collection("documents").insertOne(doc, { session });
    if (!isSale) for (const line of calculated) await db.collection("products").updateOne({ id: line.productId }, { $set: { lastPurchaseCost: line.unitPrice, lastPurchaseAt: doc.occurredAt } }, { session });
    if (cashAmount) await financialMovement(db, session, doc, isSale ? "in" : "out", cashAmount, isSale ? "sale" : "purchase");
    return doc.id;
  }
  if (type === "transfer.post") {
    const input = lines(body), fromId = text(body.fromWarehouseId), toId = text(body.toWarehouseId); if (!fromId || fromId === toId) throw new CommandError("اختر مخزنين مختلفين");
    const [from, to] = await Promise.all([warehouses(db).findOne({ _id: fromId, isArchived: { $ne: true } }, { session }), warehouses(db).findOne({ _id: toId, isArchived: { $ne: true } }, { session })]); if (!from || !to) throw new CommandError("أحد المخازن غير موجود", 404); const map = await products(db, session, input), doc = { ...baseDocument("transfer", "TRF"), partyId: null, partyName: null, warehouseId: fromId, warehouseName: from.name, destinationWarehouseId: toId, destinationWarehouseName: to.name, parentDocumentId: null, paymentMethod: null, title: null, total: 0, dueTotal: 0, paidTotal: 0, lines: input.map(l => ({ id: id("line"), productId: l.productId, description: map.get(l.productId)!.name, quantity: l.quantity, unitPrice: 0, lineTotal: 0 })) };
    for (const line of input) { const p = map.get(line.productId)!; await changeStock(db, session, p, from, -line.quantity, doc, "transfer-out"); await changeStock(db, session, p, to, line.quantity, doc, "transfer-in"); } await db.collection("documents").insertOne(doc, { session }); return doc.id;
  }
  if (type === "adjustment.post") {
    if (!Array.isArray(body.lines) || !body.lines.length) throw new CommandError("أضف منتجًا"); const input = body.lines.map(raw => { const r = raw as Input; return { productId: text(r.productId), quantity: 1, actualQuantity: positive(r.actualQuantity, "الرصيد الفعلي", true), purchaseCost: r.purchaseCost == null || r.purchaseCost === "" ? null : positive(r.purchaseCost, "تكلفة الشراء") }; }); const { warehouse, warehouseId } = await refs(db, session, body), map = await products(db, session, input), reason = text(body.reason); if (!reason) throw new CommandError("سبب التصحيح مطلوب");
    for (const line of input) {
      const product = map.get(line.productId)!, before = Number((product.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0);
      if (line.actualQuantity! > before && await authoritativeCost(db, session, product) == null && line.purchaseCost == null) throw new CommandError(`تكلفة الشراء مطلوبة لإضافة مخزون المنتج ${product.name}`);
    }
    const effectiveInput=input.filter(line=>line.actualQuantity!==Number((map.get(line.productId)!.stocks as Record<string,number>|undefined)?.[warehouseId]??0));
    if(!effectiveInput.length)throw new CommandError("لا يوجد تغيير في المخزون لاعتماده",409);
    const doc = { ...baseDocument("adjustment", "ADJ"), partyId: null, partyName: null, warehouseId, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: null, title: reason, total: 0, dueTotal: 0, paidTotal: 0, lines: [] as Record<string, unknown>[] };
    for (const line of effectiveInput) { const p = map.get(line.productId)!, before = Number((p.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0), after = line.actualQuantity!; if (after > before && p.lastPurchaseCost == null && line.purchaseCost != null) { await db.collection("products").updateOne({ id: p.id }, { $set: { lastPurchaseCost: line.purchaseCost, lastPurchaseAt: doc.occurredAt } }, { session }); p.lastPurchaseCost = line.purchaseCost; } await changeStock(db, session, p, warehouse, after - before, doc, "adjustment"); doc.lines.push({ id: id("line"), productId: line.productId, description: `${p.name} — ${reason} (قبل ${before}، بعد ${after})`, quantity: after - before, unitPrice: Number(p.lastPurchaseCost ?? 0), lineTotal: 0, balanceBefore: before, balanceAfter: after }); } await db.collection("documents").insertOne(doc, { session }); return doc.id;
  }
  if (type === "party-cash.post") {
    const partyId=text(body.partyId), party=await db.collection("parties").findOne({id:partyId},{session}); if(!party) throw new CommandError("الطرف غير موجود",404);
    const amount=positive(body.amount,"المبلغ"), direction=text(body.direction); if(direction!=="receive"&&direction!=="pay") throw new CommandError("اتجاه الحركة غير صالح");
    const method=text(body.paymentMethod); await paymentAccount(db,session,method); const snapshot=await applyPartyNetDelta(db,session,partyId,partyCashDelta(direction,amount));
    const doc={...baseDocument("payment","PAY"),partyId,partyName:party.name,warehouseId:null,warehouseName:null,destinationWarehouseId:null,destinationWarehouseName:null,parentDocumentId:null,paymentMethod:method,title:direction==="receive"?"استلام من الطرف":"دفع للطرف",note:text(body.note)||null,total:amount,dueTotal:0,paidTotal:amount,cashAmount:amount,partyCashDirection:direction,partyBalanceBefore:snapshot!.before,partyBalanceDelta:snapshot!.delta,partyBalanceAfter:snapshot!.after,lines:[]};
    await db.collection("documents").insertOne(doc,{session}); await financialMovement(db,session,doc,direction==="receive"?"in":"out",amount,direction==="receive"?"party-receipt":"party-payment"); return doc.id;
  }
  if (["payment.post", "settlement.post", "offset.post"].includes(type)) {
    const partyId = text(body.partyId), party = await db.collection("parties").findOne({ id: partyId }, { session }); if (!party) throw new CommandError("الطرف غير موجود", 404); const requested = positive(body.amount, "المبلغ"); let receivable = Number(party.receivable), payable = Number(party.payable); const side = text(body.side); if (type === "offset.post") { const amount = Math.min(requested, receivable, payable); if (amount <= 0 || requested > amount) throw new CommandError("المقاصة تتجاوز الرصيد المشترك"); receivable -= amount; payable -= amount; } else if (side === "receivable") { if (requested > receivable) throw new CommandError("المبلغ يتجاوز المستحق"); receivable -= requested; } else { if (requested > payable) throw new CommandError("المبلغ يتجاوز المستحق"); payable -= requested; }
    const kind = type.split(".")[0], method = type === "offset.post" || type === "settlement.post" ? null : text(body.paymentMethod); if (type === "payment.post") await paymentAccount(db, session, method); const doc = { ...baseDocument(kind, kind === "offset" ? "OFF" : kind === "payment" ? "PAY" : "SET"), partyId, partyName: party.name, warehouseId: null, warehouseName: null, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: method, title: side === "receivable" ? "الطرف دفع لنا" : "نحن دفعنا للطرف", total: requested, dueTotal: 0, paidTotal: requested, lines: [] }; await db.collection("parties").updateOne({ id: partyId }, { $set: { receivable, payable, net: receivable - payable } }, { session }); await db.collection("documents").insertOne(doc, { session }); if (type === "payment.post") await financialMovement(db, session, doc, side === "receivable" ? "in" : "out", requested, side === "receivable" ? "party-receipt" : "party-payment"); return doc.id;
  }
  if (type === "expense.post") { const title = text(body.title), amount = positive(body.amount, "المبلغ"), occurredAt = text(body.occurredAt); if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(occurredAt)) throw new CommandError("العنوان والتاريخ مطلوبان"); const method = text(body.paymentMethod); await paymentAccount(db, session, method); const doc = { ...await numberedDocument(db, session, "expense", "EXP"), occurredAt: new Date(`${occurredAt}T12:00:00Z`).toISOString(), partyId: null, partyName: null, warehouseId: null, warehouseName: null, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: method, title, total: amount, dueTotal: 0, paidTotal: amount, lines: [{ id: id("line"), productId: null, description: title, quantity: 1, unitPrice: amount, lineTotal: amount }] }; await financialMovement(db, session, doc, "out", amount, "expense"); await db.collection("documents").insertOne(doc, { session }); return doc.id; }
  if (type === "expense.update") {
    const documentId=text(body.documentId),title=text(body.title),amount=positive(body.amount,"المبلغ"),date=text(body.occurredAt),method=text(body.paymentMethod);
    if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new CommandError("العنوان والتاريخ مطلوبان");
    const original=await db.collection("documents").findOne({id:documentId,kind:"expense",status:"posted"},{session});
    if(!original||original.legacyKey)throw new CommandError("المصروف غير موجود أو غير قابل للتعديل",404);
    const movement=await db.collection("financialMovements").findOne({documentId,type:"expense"},{session});
    if(!movement)throw new CommandError("تعذر العثور على حركة المصروف الأصلية",409);
    const oldAccount=await paymentAccount(db,session,movement.paymentMethod,false);
    await db.collection("paymentAccounts").updateOne({id:oldAccount.id},{$inc:{balance:Number(movement.amount)}},{session});
    await db.collection("financialMovements").deleteOne({_id:movement._id},{session});
    const occurredAt=new Date(`${date}T12:00:00Z`).toISOString(),lineId=(original.lines as Line[]|undefined)?.[0]?.id??id("line");
    const revised={title,total:amount,dueTotal:0,paidTotal:amount,cashAmount:amount,paymentMethod:method,occurredAt,lines:[{id:lineId,productId:null,description:title,quantity:1,unitPrice:amount,lineTotal:amount}],updatedAt:new Date(),revision:Number(original.revision??0)+1};
    await financialMovement(db,session,{...original,...revised},"out",amount,"expense");
    await db.collection("documents").updateOne({id:documentId,kind:"expense",status:"posted"},{$set:revised},{session});
    return documentId;
  }
  if (type === "payment-account.update") { const accountId=text(body.id),name=text(body.name);if(!name)throw new CommandError("بيانات وسيلة الدفع غير صالحة");const color=text(body.color);await paymentAccount(db,session,accountId,false);await db.collection("paymentAccounts").updateOne({id:accountId},{$set:{name,...(color&&/^#[0-9a-f]{6}$/i.test(color)?{color}:{}),isActive:body.isActive!==false,allowNegativeBalance:true,updatedAt:new Date()}},{session});return accountId; }
  if(type==="expense.void"){
    const documentId=text(body.documentId),original=await db.collection("documents").findOne({id:documentId,kind:"expense",status:"posted"},{session});
    if(!original)throw new CommandError("فاتورة المصروف غير موجودة أو ملغاة بالفعل",404);
    if(original.legacyKey)throw new CommandError("الفواتير المرحلة متاحة للعرض فقط",409);
    const movement=await db.collection("financialMovements").findOne({documentId,type:"expense"},{session});
    if(!movement)throw new CommandError("تعذر العثور على حركة المصروف الأصلية",409);
    const account=await paymentAccount(db,session,movement.paymentMethod,false),amount=Number(movement.amount);
    if(!Number.isFinite(amount)||amount<=0)throw new CommandError("حركة المصروف الأصلية غير صالحة",409);
    const restored=await db.collection("paymentAccounts").updateOne({id:account.id},{$inc:{balance:amount}},{session});
    if(!restored.matchedCount)throw new CommandError("تعذر إعادة مبلغ المصروف",409);
    await db.collection("financialMovements").deleteOne({_id:movement._id},{session});
    await db.collection("documents").updateOne({id:documentId,kind:"expense",status:"posted"},{$set:{status:"voided",voidedAt:new Date(),updatedAt:new Date()},$inc:{revision:1}},{session});
    return documentId;
  }
  if (type === "payment-account.create") { const name = text(body.name), openingBalance = num(body.openingBalance ?? 0); if (!name) throw new CommandError("اسم البنك أو وسيلة الدفع مطلوب");if(!Number.isFinite(openingBalance))throw new CommandError("رصيد البداية غير صالح"); const account = { id: id("account"), code: id("custom"), name, color: "#1677c8", icon: "wallet", isActive: true, allowNegativeBalance: true, openingBalance, balance: 0, createdAt: new Date() }; await db.collection("paymentAccounts").insertOne(account, { session }); if (openingBalance !== 0) { const doc = { ...baseDocument("opening-balance", "OPEN"), paymentMethod: account.id, partyId: null, partyName: null, note: "رصيد بداية" }; await financialMovement(db, session, doc, openingBalance>=0?"in":"out", Math.abs(openingBalance), "opening-balance"); } return account.id; }
  if(type==="payment-account.delete"){const account=await paymentAccount(db,session,body.accountId,false);if(account.code==="cash")throw new CommandError("لا يمكن حذف وسيلة الدفع النقدية الأساسية",409);if(Number(account.balance??0)!==0)throw new CommandError("لا يمكن حذف أو أرشفة وسيلة الدفع ورصيدها غير صفري. صفّر أو سوِّ الرصيد أولًا.",409);const key=[account.id,account.code], [movement,document,transfer]=await Promise.all([db.collection("financialMovements").findOne({paymentMethod:{$in:key}},{session}),db.collection("documents").findOne({paymentMethod:{$in:key}},{session}),db.collection("accountTransfers").findOne({$or:[{fromAccountId:{$in:key}},{toAccountId:{$in:key}}]},{session})]);if(movement||document||transfer){await db.collection("paymentAccounts").updateOne({id:account.id},{$set:{isActive:false,isArchived:true,archivedAt:new Date(),updatedAt:new Date()}},{session});return {id:String(account.id),disposition:"archived"}}await db.collection("paymentAccounts").deleteOne({id:account.id},{session});return {id:String(account.id),disposition:"deleted"}}
  if(type==="payment-account.restore"){const account=await paymentAccount(db,session,body.accountId,false);if(account.code==="cash"||account.isArchived!==true)throw new CommandError("وسيلة الدفع غير مؤرشفة",409);await db.collection("paymentAccounts").updateOne({id:account.id,isArchived:true},{$set:{isArchived:false,isActive:true,archivedAt:null,updatedAt:new Date()}},{session});return String(account.id)}
  if(type==="account-opening-balance-correction.post"){const account=await paymentAccount(db,session,body.accountId,false),currentBalance=Number(account.balance??0),newOpening=num(body.newOpeningBalance),reason=text(body.reason);if(!Number.isFinite(newOpening))throw new CommandError("رصيد البداية الصحيح غير صالح");if(!reason)throw new CommandError("سبب التصحيح مطلوب");let oldOpening=Number(account.openingBalance);if(!Number.isFinite(oldOpening)){const history=await db.collection("financialMovements").find({paymentMethod:{$in:[account.id,account.code]},type:{$in:["opening-balance","opening-balance-correction"]}},{session}).toArray();oldOpening=history.reduce((sum,movement)=>sum+(Number.isFinite(Number(movement.delta))?Number(movement.delta):(movement.direction==="out"?-Number(movement.amount??0):Number(movement.amount??0))),0)}const delta=newOpening-oldOpening;if(delta===0)throw new CommandError("رصيد البداية الجديد يطابق الرصيد الحالي.");const newCurrentBalance=currentBalance+delta,occurredAt=new Date().toISOString(),movementId=id("fin"),reference=`OPEN-COR-${Date.now()}`;const updated=await db.collection("paymentAccounts").updateOne({id:account.id,balance:currentBalance},{$set:{openingBalance:newOpening,balance:newCurrentBalance,updatedAt:new Date()}},{session});if(!updated.matchedCount)throw new CommandError("تغير الرصيد أثناء العملية، أعد المحاولة",409);await db.collection("financialMovements").insertOne({id:movementId,paymentMethod:account.id,paymentCode:account.code,direction:delta>=0?"in":"out",amount:Math.abs(delta),delta,openingBalanceBefore:oldOpening,openingBalanceAfter:newOpening,balanceBefore:currentBalance,balanceAfter:newCurrentBalance,reason,note:reason,type:"opening-balance-correction",occurredAt,documentId:movementId,documentNumber:reference,partyId:null,partyName:null,transferId:null},{session});return movementId}
  if (type === "account-adjustment.post") { const account = await paymentAccount(db, session, body.accountId), direction = text(body.direction), amount = positive(body.amount, "المبلغ"); if (!['deposit', 'withdrawal'].includes(direction)) throw new CommandError("نوع العملية غير صالح"); const doc = { ...baseDocument("account-adjustment", direction === "deposit" ? "DEP" : "WDR"), paymentMethod: account.id, partyId: null, partyName: null, note: text(body.note) }; await financialMovement(db, session, doc, direction === "deposit" ? "in" : "out", amount, direction === "deposit" ? "manual-deposit" : "manual-withdrawal"); return String(doc.id); }
  if (type === "account-transfer.post") { const from = await paymentAccount(db, session, body.fromAccountId), to = await paymentAccount(db, session, body.toAccountId), amount = positive(body.amount, "المبلغ"); if (from.id === to.id) throw new CommandError("اختر حسابين مختلفين"); const transferId = id("transfer"), doc = { ...baseDocument("payment-transfer", "BTR"), transferId, paymentMethod: from.id, note: text(body.note), partyId: null, partyName: null }; await financialMovement(db, session, doc, "out", amount, "transfer-out"); doc.paymentMethod = to.id; await financialMovement(db, session, doc, "in", amount, "transfer-in"); await db.collection("accountTransfers").insertOne({ id: transferId, number: doc.number, fromAccountId: from.id, toAccountId: to.id, amount, note: doc.note, occurredAt: doc.occurredAt }, { session }); return transferId; }
  throw new CommandError("العملية غير مدعومة");
}

export async function POST(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
  let type = "unknown";
  try {
    const body = await request.json() as Input; type = text(body.type);
    const map:Record<string,Capability>={"product.delete":"products.delete","product.restore":"products.edit","product.create":"products.create","product.update":"products.edit","warehouse.create":"warehouses.create","warehouse.update":"warehouses.edit","warehouse.default":"warehouses.edit","warehouse.delete":"warehouses.delete","sale.post":"pos.create","sale.update":"pos.edit","sale.void":"pos.delete","purchase.post":"purchases.create","purchase.update":"purchases.edit","purchase.void":"purchases.delete","transfer.post":"warehouses.transfer","adjustment.post":"warehouses.adjust","payment.post":text(body.side)==="receivable"?"customers.collect":"suppliers.pay","party-cash.post":text(body.partyType)==="supplier"?"suppliers.pay":"customers.collect","settlement.post":"customers.edit","offset.post":"customers.edit","expense.post":"expenses.create","expense.update":"expenses.edit","expense.void":"expenses.delete","payment-account.create":"banks.create","payment-account.update":"banks.edit","payment-account.delete":"banks.delete","payment-account.restore":"banks.edit","account-adjustment.post":"banks.deposit_withdraw","account-transfer.post":"banks.transfer","account-opening-balance-correction.post":"banks.balance_correct","party.create":body.partyType==="customer"?"customers.create":"suppliers.create"};
    const capability=map[type];if(!capability)return Response.json({error:"العملية غير مدعومة"},{status:400});const denied=await requireCapability(request,capability);if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
    const idempotencyKey=text(request.headers.get("Idempotency-Key"));
    if(!idempotencyKey||idempotencyKey.length>200)return Response.json({error:"مفتاح العملية مطلوب"},{status:400});
    const fingerprint=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(body)))).toString("hex");
    const db=await getDatabase(),receipts=db.collection("commandReceipts"),prior=await receipts.findOne({_id:idempotencyKey as never});
    if(prior){if(prior.fingerprint!==fingerprint)return Response.json({error:"مفتاح العملية مستخدم لطلب مختلف"},{status:409});if(prior.status==="committed")return Response.json(prior.result);return Response.json({error:"العملية قيد التنفيذ"},{status:409});}
    let result:unknown="",response:unknown;
    try{await db.transaction(async session=>{
      await receipts.insertOne({_id:idempotencyKey as never,commandType:type,fingerprint,status:"processing",createdAt:new Date()},{session});
      await db.collection("auditEvents").insertOne({id:id("audit"),action:type,status:"started",createdAt:new Date()},{session});
      result=await execute(db,session,body);response=typeof result==="object"&&result?result:{id:result};
      await db.collection("auditEvents").insertOne({id:id("audit"),action:type,entityId:typeof result==="object"&&result?(result as {id?:unknown}).id:result,status:"committed",createdAt:new Date()},{session});
      await receipts.updateOne({_id:idempotencyKey as never},{$set:{status:"committed",result:response,committedAt:new Date()}},{session});
    });}
    catch(error){if((error as {code?:number}).code===11000){const duplicate=await receipts.findOne({_id:idempotencyKey as never});if(duplicate?.fingerprint!==fingerprint)return Response.json({error:"مفتاح العملية مستخدم لطلب مختلف"},{status:409});if(duplicate?.status==="committed")return Response.json(duplicate.result);return Response.json({error:"العملية قيد التنفيذ"},{status:409});}throw error;}
    log("info","api.command.completed",{commandType:type,entityId:result});return Response.json(response);
  }catch(error){const status=error instanceof CommandError?error.status:500;log("error","api.command.failed",{commandType:type,error});return Response.json({error:error instanceof CommandError?error.message:"تعذر تنفيذ العملية"},{status});}
}
