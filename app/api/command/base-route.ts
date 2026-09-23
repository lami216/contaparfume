import { requireValidLicense } from "../../../lib/license.ts";
import type { SqliteSession as ClientSession, SqliteDatabase as Db } from "../../../lib/sqlite.ts";
import { getDatabase } from "../../../lib/sqlite.ts";
import { log } from "../../../lib/log.ts";
import { requireCapability, validSameOrigin, type Capability } from "../../../lib/auth.ts";
import { isProductExpired, resolvePartyType } from "../../domain.ts";
import { roundedDivisionLiquidCost, type PerfumeAllocation, type PerfumeLot } from "../../perfume-logic.ts";
import { handlePerfumeInvoiceCommand } from "../../perfume-invoice-commands.ts";
import { normalizePartyNet, partyNet } from "../../party-balance.ts";
import { nextDocumentSequence, type SequencedDocumentKind } from "../../../lib/document-sequences.ts";
import { deriveOpeningStockState, planOpeningStockCorrection } from "../../../lib/opening-stock.ts";
import { currentProductCost, resolveProductCost } from "../../../lib/product-cost.ts";
import { executeLifecycleCommand, findActiveFinancialMovement, LifecycleCommandError, propagatePartyName, reverseFinancialMovement } from "../../../lib/transaction-lifecycle.ts";

type Input = Record<string, unknown>;
type Line = { id?: string; productId: string; quantity: number; description?: string; piecePrice?: number; unitPrice?: number; actualQuantity?: number; costAtSale?: number | null; grossProfit?: number | null; perfumeAllocations?: PerfumeAllocation[] };
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
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new CommandError("تاريخ انتهاء الصلاحية غير صالح");
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
async function paymentAccountForHistoricalEdit(db: Db, session: ClientSession, value: unknown, originalValue: unknown) {
  const account = await paymentAccount(db, session, value, false), originalKey = text(originalValue);
  const sameOriginal = Boolean(originalKey) && (String(account.id) === originalKey || String(account.code ?? "") === originalKey);
  if (!sameOriginal && (account.isActive !== true || account.isArchived === true)) throw new CommandError("يجب اختيار وسيلة دفع صالحة");
  return { account, sameOriginal };
}
async function reactivateHistoricalPaymentAccount(db: Db, session: ClientSession, account: Record<string, unknown>, sameOriginal: boolean) {
  if (!sameOriginal || (account.isActive === true && account.isArchived !== true)) return;
  await db.collection("paymentAccounts").updateOne({ id: account.id }, { $set: { isActive: true, isArchived: false, archivedAt: null, updatedAt: new Date() } }, { session });
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
  await db.collection("financialMovements").insertOne({ id: id("fin"), paymentMethod: account.id, paymentCode: account.code, direction, amount, documentId: document.id, documentNumber: document.number, partyId: document.partyId ?? null, partyName: document.partyName ?? null, type, occurredAt: document.occurredAt, transferId: document.transferId ?? null, note: document.note ?? null, status: "posted", revision: Number(document.revision ?? 0) }, { session });
}
async function authoritativeCost(db: Db, session: ClientSession, product: Record<string, unknown>) {
  if (product.perfumeForm === "partial" && Number.isFinite(Number(product.pieceCost))) return Number(product.pieceCost);
  return currentProductCost(db, session, product);
}
async function historicalCost(db: Db, session: ClientSession, productId: string, occurredAt: string) {
  const documents = await db.collection("documents").find(
    { status: "posted", occurredAt: { $lte: occurredAt }, "lines.productId": productId }, { session },
  ).toArray();
  // Do not pass today's product metadata into a historical invoice correction.
  return resolveProductCost({ id: productId }, documents).cost;
}
async function changePartyDebt(db: Db, session: ClientSession, partyId: unknown, kind: "sale" | "purchase", delta: number, reversing = false) {
  if (!delta) return;
  await applyPartyNetDelta(db, session, partyId, kind === "sale" ? delta : -delta, reversing);
}
async function applyPartyNetDelta(db: Db, session: ClientSession, partyId: unknown, delta: number, reversing = false) {
  const party = await db.collection("parties").findOne({ id: String(partyId) }, { session });
  if (!party) { if (reversing) throw new CommandError("لا يمكن تعديل رصيد الطرف", 409); return null; }
  const before = partyNet(party as {receivable?:unknown;payable?:unknown});
  const after = before + delta;
  await db.collection("parties").updateOne({ _id: party._id }, { $set: { ...normalizePartyNet(after), lastMovementAt: new Date(), ...(party.isArchived===true&&after!==0?{isArchived:false,archivedAt:null}: {}) } }, { session });
  return { before, delta, after };
}
async function preserveHistoricalPartyArchiveIfBalanced(db:Db,session:ClientSession,partyId:string,wasArchived:boolean,archivedAt:unknown){
  if(!wasArchived)return;
  const party=await db.collection("parties").findOne({id:partyId},{session});
  if(!party||partyNet(party as {receivable?:unknown;payable?:unknown})!==0)return;
  await db.collection("parties").updateOne({id:partyId},{$set:{isArchived:true,archivedAt:archivedAt??new Date(),updatedAt:new Date()}},{session});
}
async function reverseInvoicePayment(db: Db, session: ClientSession, document: Record<string, unknown>, kind: "sale" | "purchase") {
  const amount = Number(document.cashAmount ?? document.paidTotal ?? 0);
  if (!amount) return;
  const movement = await findActiveFinancialMovement(db, session, { documentId: document.id, type: kind });
  if (!movement) throw new CommandError("تعذر العثور على حركة الدفع الأصلية للفاتورة", 409);
  await reverseFinancialMovement(db, session, movement, "عكس دفعة فاتورة");
}
async function recomputePurchaseCosts(db: Db, session: ClientSession, productIds: string[]) {
  for (const productId of new Set(productIds)) {
    const product = await db.collection("products").findOne({ id: productId }, { session });
    if (product) await currentProductCost(db, session, product);
  }
}
async function accountOpeningBasis(db: Db, session: ClientSession, account: Record<string, unknown>) {
  const stored=Number(account.openingBalance);
  if(Number.isFinite(stored))return stored;
  const history=await db.collection("financialMovements").find({paymentMethod:{$in:[account.id,account.code]},type:{$in:["opening-balance","opening-balance-correction"]},status:{$ne:"reversed"},isReversal:{$ne:true}},{session}).toArray();
  return history.reduce((sum,movement)=>sum+(Number.isFinite(Number(movement.delta))?Number(movement.delta):(movement.direction==="out"?-Number(movement.amount??0):Number(movement.amount??0))),0);
}
async function latestOpeningCorrection(db: Db, session: ClientSession, account: Record<string, unknown>) {
  const rows=await db.collection("financialMovements").find({paymentMethod:{$in:[account.id,account.code]},type:"opening-balance-correction",status:{$ne:"reversed"},isReversal:{$ne:true}},{session}).sort({occurredAt:-1,id:-1}).limit(1).toArray();
  return rows[0]??null;
}
async function postOpeningCorrection(db: Db, session: ClientSession, account: Record<string, unknown>, newOpening: number, reason: string, replacesMovementId?: string, revision=0) {
  const currentBalance=Number(account.balance??0),oldOpening=await accountOpeningBasis(db,session,account);
  if(!Number.isFinite(currentBalance)||!Number.isFinite(oldOpening))throw new CommandError("بيانات رصيد الحساب غير صالحة",409);
  const delta=newOpening-oldOpening;
  if(delta===0)throw new CommandError("رصيد البداية الجديد يطابق الرصيد الحالي.");
  const newCurrentBalance=currentBalance+delta,occurredAt=new Date().toISOString(),movementId=id("fin"),reference=`OPEN-COR-${Date.now()}-${crypto.randomUUID().slice(0,6)}`;
  const updated=await db.collection("paymentAccounts").updateOne({id:account.id,balance:currentBalance},{$set:{openingBalance:newOpening,balance:newCurrentBalance,updatedAt:new Date()}},{session});
  if(!updated.matchedCount)throw new CommandError("تغير الرصيد أثناء العملية، أعد المحاولة",409);
  await db.collection("financialMovements").insertOne({id:movementId,paymentMethod:account.id,paymentCode:account.code,direction:delta>=0?"in":"out",amount:Math.abs(delta),delta,openingBalanceBefore:oldOpening,openingBalanceAfter:newOpening,balanceBefore:currentBalance,balanceAfter:newCurrentBalance,reason,note:reason,type:"opening-balance-correction",occurredAt,documentId:movementId,documentNumber:reference,partyId:null,partyName:null,transferId:null,status:"posted",revision,replacesMovementId:replacesMovementId??null},{session});
  return movementId;
}
async function requireLatestOpeningCorrection(db: Db, session: ClientSession, movementId: string) {
  const original=await findActiveFinancialMovement(db,session,{id:movementId,type:"opening-balance-correction"});
  if(!original)throw new CommandError("تصحيح رصيد البداية غير موجود أو ملغى",404);
  const account=await paymentAccount(db,session,original.paymentMethod,false),latest=await latestOpeningCorrection(db,session,account);
  if(!latest||String(latest.id)!==String(original.id))throw new CommandError("يمكن تعديل أو إلغاء آخر تصحيح رصيد بداية فقط",409);
  const before=Number(original.openingBalanceBefore),after=Number(original.openingBalanceAfter),currentOpening=await accountOpeningBasis(db,session,account);
  if(!Number.isFinite(before)||!Number.isFinite(after)||currentOpening!==after)throw new CommandError("تسلسل تصحيحات رصيد البداية لا يسمح بهذه العملية",409);
  return {original,account,before,after};
}
async function propagateWarehouseName(db: Db, session: ClientSession, warehouseId: string, previousName: string, currentName: string) {
  if (!currentName || currentName === previousName) return;
  const documents = await db.collection("documents").find({ $or: [{ warehouseId }, { destinationWarehouseId: warehouseId }] }, { session }).toArray();
  for (const document of documents) {
    const update: Record<string, unknown> = {};
    if (String(document.warehouseId ?? "") === warehouseId) {
      if (!document.warehouseNameOriginal && document.warehouseName) update.warehouseNameOriginal = document.warehouseName;
      update.warehouseName = currentName;
    }
    if (String(document.destinationWarehouseId ?? "") === warehouseId) {
      if (!document.destinationWarehouseNameOriginal && document.destinationWarehouseName) update.destinationWarehouseNameOriginal = document.destinationWarehouseName;
      update.destinationWarehouseName = currentName;
    }
    if (Object.keys(update).length) await db.collection("documents").updateOne({ _id: document._id }, { $set: update }, { session });
  }
  const movements = await db.collection("stockMovements").find({ warehouseId }, { session }).toArray();
  for (const movement of movements) {
    const update: Record<string, unknown> = { warehouseName: currentName };
    if (!movement.warehouseNameOriginal && movement.warehouseName) update.warehouseNameOriginal = movement.warehouseName;
    await db.collection("stockMovements").updateOne({ _id: movement._id }, { $set: update }, { session });
  }
}
async function refs(db: Db, session: ClientSession, body: Input, requireParty = false) {
  const warehouseId = text(body.warehouseId), partyId = text(body.partyId);
  const [warehouse, party] = await Promise.all([
    warehouseId ? warehouses(db).findOne({ _id: warehouseId, isArchived: { $ne: true } }, { session }) : null,
    partyId ? db.collection("parties").findOne({ id: partyId, isArchived: { $ne: true } }, { session }) : null,
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
async function productsForUpdate(db: Db, session: ClientSession, input: Line[], originalProductIds: ReadonlySet<string>) {
  const ids=input.map(line=>line.productId),found=await db.collection("products").find({id:{$in:ids}},{session}).toArray();
  if(found.length!==new Set(ids).size)throw new CommandError("أحد المنتجات غير موجود",404);
  for(const product of found)if(product.isArchived===true&&!originalProductIds.has(String(product.id)))throw new CommandError("لا يمكن إضافة منتج محذوف إلى فاتورة",409);
  return new Map(found.map(product=>[String(product.id),product]));
}
async function invoiceUpdateRefs(db:Db,session:ClientSession,body:Input,original:Record<string,unknown>,requireParty:boolean){
  const warehouseId=text(body.warehouseId),partyId=text(body.partyId),originalWarehouseId=String(original.warehouseId??""),originalPartyId=String(original.partyId??"");
  const warehouse=warehouseId?await warehouses(db).findOne({_id:warehouseId,...(warehouseId===originalWarehouseId?{}:{isArchived:{$ne:true}})},{session}):null;
  const party=partyId?await db.collection("parties").findOne({id:partyId,...(partyId===originalPartyId?{}:{isArchived:{$ne:true}})},{session}):null;
  if(!warehouse)throw new CommandError("المخزن غير موجود",404);
  if(requireParty&&!party)throw new CommandError("الطرف غير موجود",404);
  if(partyId&&partyId!==originalPartyId&&!party)throw new CommandError("الطرف غير موجود",404);
  return {warehouse,party,warehouseId,partyId};
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
  if (after !== 0 && warehouse.isArchived === true) {
    await warehouses(db).updateOne({ _id: warehouseId, isArchived: true }, { $set: { isArchived: false, archivedAt: null, updatedAt: new Date() } }, { session });
    warehouse.isArchived = false;
  }
  await db.collection("stockMovements").insertOne({ id: id("mov"), documentId: document.id, documentNumber: document.number, warehouseId, warehouseName: warehouse.name, productId, productName: product.name, type, quantityDelta: delta, balanceBefore: before, balanceAfter: after, occurredAt: document.occurredAt, documentRevision: Number(document.revision ?? 0) }, { session });
  return { before, after };
}

function perfumeLots(product: Record<string, unknown>) {
  return structuredClone(Array.isArray(product.perfumeLots) ? product.perfumeLots : []) as PerfumeLot[];
}
async function savePerfumeLots(db: Db, session: ClientSession, product: Record<string, unknown>, lots: PerfumeLot[]) {
  await db.collection("products").updateOne({ id: product.id }, { $set: { perfumeLots: lots } }, { session });
  product.perfumeLots = lots;
}
async function consumePerfumeLots(db: Db, session: ClientSession, product: Record<string, unknown>, warehouseId: string, quantity: number) {
  if (product.perfumeForm !== "decant") return null;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new CommandError("كمية التقسيمات يجب أن تكون عددًا صحيحًا");
  const lots = perfumeLots(product).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
  let remaining = quantity, totalCost = 0;
  const allocations: PerfumeAllocation[] = [];
  for (const lot of lots) {
    const available = Number(lot.stocks?.[warehouseId] ?? 0);
    if (available <= 0 || remaining <= 0) continue;
    const take = Math.min(available, remaining);
    lot.stocks = { ...(lot.stocks ?? {}), [warehouseId]: available - take };
    lot.remainingQuantity = Math.max(0, Number(lot.remainingQuantity ?? 0) - take);
    const unitCost = Number(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0);
    totalCost += take * unitCost;
    allocations.push({ lotId: lot.id, quantity: take, unitCost, warehouseId });
    remaining -= take;
  }
  if (remaining > 0) throw new CommandError("مخزون دفعات التقسيمات غير كافٍ", 409);
  await savePerfumeLots(db, session, product, lots);
  return { allocations, totalCost, costAtSale: totalCost / quantity };
}
async function restorePerfumeAllocations(db: Db, session: ClientSession, product: Record<string, unknown>, allocations: PerfumeAllocation[] | undefined) {
  if (product.perfumeForm !== "decant" || !allocations?.length) return;
  const lots = perfumeLots(product), byId = new Map(lots.map(lot => [lot.id, lot]));
  for (const allocation of allocations) {
    const lot = byId.get(allocation.lotId); if (!lot) throw new CommandError("تعذر العثور على دفعة التقسيم الأصلية", 409);
    const amount = Number(allocation.quantity); const warehouseId = String(allocation.warehouseId);
    lot.stocks = { ...(lot.stocks ?? {}), [warehouseId]: Number(lot.stocks?.[warehouseId] ?? 0) + amount };
    lot.remainingQuantity = Number(lot.remainingQuantity ?? 0) + amount;
  }
  await savePerfumeLots(db, session, product, lots);
}
async function transferPerfumeLots(db: Db, session: ClientSession, product: Record<string, unknown>, fromId: string, toId: string, quantity: number) {
  if (product.perfumeForm !== "decant") return;
  if (!Number.isInteger(quantity) || quantity <= 0) throw new CommandError("كمية التقسيمات يجب أن تكون عددًا صحيحًا");
  const lots = perfumeLots(product).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
  let remaining = quantity;
  for (const lot of lots) {
    const available = Number(lot.stocks?.[fromId] ?? 0); if (available <= 0 || remaining <= 0) continue;
    const move = Math.min(available, remaining);
    lot.stocks = { ...(lot.stocks ?? {}), [fromId]: available - move, [toId]: Number(lot.stocks?.[toId] ?? 0) + move };
    remaining -= move;
  }
  if (remaining > 0) throw new CommandError("لا يمكن نقل كمية تقسيمات أكبر من دفعات المخزن", 409);
  await savePerfumeLots(db, session, product, lots);
}



export async function execute(db: Db, session: ClientSession, body: Input) {
  const type = text(body.type);
  const lifecycle = await executeLifecycleCommand(db, session, body);
  if (lifecycle.handled) return lifecycle.result;
  const perfumeInvoiceResult = await handlePerfumeInvoiceCommand(db, session, body);
  if (perfumeInvoiceResult !== null) return perfumeInvoiceResult;
  if (type === "perfume-split.post") {
    const sourceProductId=text(body.sourceProductId),warehouseId=text(body.warehouseId);
    const source=await db.collection("products").findOne({id:sourceProductId,isArchived:{$ne:true}},{session});
    if(!source)throw new CommandError("العطر غير موجود",404);
    if(["decant","partial","bottle"].includes(String(source.perfumeForm??"")))throw new CommandError("لا يمكن تقسيم منتج مولد من التقسيمات",409);
    const warehouse=await warehouses(db).findOne({_id:warehouseId,isArchived:{$ne:true}},{session});if(!warehouse)throw new CommandError("المخزن غير موجود",404);
    const stock=Number((source.stocks as Record<string,number>|undefined)?.[warehouseId]??0);if(stock<1)throw new CommandError(`المخزون غير كافٍ للمنتج ${source.name}`);
    const divisionsCount=positive(body.divisionsCount,"عدد التقسيمات");if(!Number.isInteger(divisionsCount)||divisionsCount<2)throw new CommandError("عدد التقسيمات يجب أن يكون عددًا صحيحًا أكبر من 1");
    const salePrice=Math.ceil(positive(body.salePrice,"سعر البيع للتقسيمة"));
    const sourceCost=await authoritativeCost(db,session,source);if(sourceCost==null||sourceCost<=0)throw new CommandError("لا توجد تكلفة شراء معتمدة لهذا العطر",409);
    const liquidUnitCost=roundedDivisionLiquidCost(sourceCost,divisionsCount);
    const doc={...baseDocument("adjustment","SPL"),perfumeConversionType:"perfume-split",partyId:null,partyName:null,warehouseId,warehouseName:warehouse.name,destinationWarehouseId:null,destinationWarehouseName:null,parentDocumentId:null,paymentMethod:null,title:"تحويل عطر إلى تقسيمات",total:0,dueTotal:0,paidTotal:0,lines:[] as Record<string,unknown>[]};
    let decant=await db.collection("products").findOne({perfumeForm:"decant",parentProductId:sourceProductId,isArchived:{$ne:true}},{session});
    if(!decant){const sku=await nextProductCode(db,session);decant={id:id("product"),sku,name:`${source.name} — تقسيمة`,barcode:"",pieceCost:liquidUnitCost,lastPurchaseCost:null,lastPurchaseAt:null,piecePrice:salePrice,wholesalePrice:null,expiryDate:null,note:null,categoryId:source.categoryId??null,perfumeForm:"decant",parentProductId:sourceProductId,decantSizeMl:null,decantBottleCost:0,perfumeLots:[],stocks:{},createdAt:new Date()};await db.collection("products").insertOne(decant,{session})}else{await db.collection("products").updateOne({id:decant.id},{$set:{name:`${source.name} — تقسيمة`,piecePrice:salePrice,pieceCost:liquidUnitCost,decantSizeMl:null,decantBottleCost:0}},{session});decant.name=`${source.name} — تقسيمة`;decant.piecePrice=salePrice;decant.pieceCost=liquidUnitCost;decant.decantSizeMl=null;decant.decantBottleCost=0}
    const lot:PerfumeLot={id:id("lot"),sourceProductId,sourceProductName:String(source.name),originalQuantity:divisionsCount,remainingQuantity:divisionsCount,liquidUnitCost,bottleCost:0,landedUnitCost:liquidUnitCost,decantSizeMl:null,stocks:{[warehouseId]:divisionsCount},createdAt:String(doc.occurredAt),conversionDocumentId:String(doc.id)};
    const lots=perfumeLots(decant);lots.push(lot);await savePerfumeLots(db,session,decant,lots);await db.collection("products").updateOne({id:sourceProductId},{$set:{perfumeForm:"full"}},{session});source.perfumeForm="full";
    await changeStock(db,session,source,warehouse,-1,doc,"perfume-split-out");await changeStock(db,session,decant,warehouse,divisionsCount,doc,"perfume-split-in");
    doc.lines=[{id:id("line"),productId:sourceProductId,description:String(source.name),quantity:-1,unitPrice:sourceCost,lineTotal:0},{id:id("line"),productId:String(decant.id),description:String(decant.name),quantity:divisionsCount,unitPrice:liquidUnitCost,lineTotal:0,perfumeLotId:lot.id}];await db.collection("documents").insertOne(doc,{session});return String(doc.id);
  }
  if(type==="perfume-recombine.post"){
    const decantProductId=text(body.decantProductId),lotId=text(body.lotId),warehouseId=text(body.warehouseId),salePrice=Math.ceil(positive(body.salePrice,"سعر بيع العطر الناقص"));
    const decant=await db.collection("products").findOne({id:decantProductId,perfumeForm:"decant",isArchived:{$ne:true}},{session});if(!decant)throw new CommandError("دفعة التقسيم غير موجودة",404);
    const lots=perfumeLots(decant),lot=lots.find(item=>item.id===lotId);if(!lot)throw new CommandError("دفعة التقسيم غير موجودة",404);
    const remaining=Number(lot.remainingQuantity??0);if(!Number.isInteger(remaining)||remaining<=0)throw new CommandError("لا توجد تقسيمات متبقية في هذه الدفعة",409);
    const locations=Object.entries(lot.stocks??{}).filter(([,value])=>Number(value)>0);if(locations.length!==1||String(locations[0][0])!==warehouseId||Number(locations[0][1])!==remaining)throw new CommandError("يجب جمع كل التقسيمات المتبقية في مخزن واحد قبل إرجاعها",409);
    const warehouse=await warehouses(db).findOne({_id:warehouseId,isArchived:{$ne:true}},{session});if(!warehouse)throw new CommandError("المخزن غير موجود",404);
    const source=await db.collection("products").findOne({id:lot.sourceProductId},{session});if(!source)throw new CommandError("العطر الأصلي غير موجود",409);
    const partialCost=remaining*Number(lot.liquidUnitCost),sku=await nextProductCode(db,session),partial={id:id("product"),sku,name:`${source.name} — ناقص ${remaining}/${lot.originalQuantity}`,barcode:"",pieceCost:partialCost,lastPurchaseCost:null,lastPurchaseAt:null,piecePrice:salePrice,wholesalePrice:null,expiryDate:null,note:null,perfumeForm:"partial",parentProductId:String(source.id),partialRemainingParts:remaining,partialOriginalParts:Number(lot.originalQuantity),stocks:{},createdAt:new Date()};
    await db.collection("products").insertOne(partial,{session});const doc={...baseDocument("adjustment","RCB"),perfumeConversionType:"perfume-recombine",partyId:null,partyName:null,warehouseId,warehouseName:warehouse.name,destinationWarehouseId:null,destinationWarehouseName:null,parentDocumentId:lot.conversionDocumentId,paymentMethod:null,title:"تحويل الباقي إلى عطر ناقص",total:0,dueTotal:0,paidTotal:0,lines:[] as Record<string,unknown>[]};
    await changeStock(db,session,decant,warehouse,-remaining,doc,"perfume-recombine-out");await changeStock(db,session,partial,warehouse,1,doc,"perfume-recombine-in");lot.stocks={...(lot.stocks??{}),[warehouseId]:0};lot.remainingQuantity=0;lot.recombinedAt=String(doc.occurredAt);lot.partialProductId=String(partial.id);await savePerfumeLots(db,session,decant,lots);doc.lines=[{id:id("line"),productId:decantProductId,description:String(decant.name),quantity:-remaining,unitPrice:Number(lot.landedUnitCost),lineTotal:0},{id:id("line"),productId:String(partial.id),description:String(partial.name),quantity:1,unitPrice:partialCost,lineTotal:0}];await db.collection("documents").insertOne(doc,{session});return String(partial.id);
  }
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
    if (phone) { const existing = await db.collection("parties").findOne({ phone, partyType }, { session }); if (existing) throw new CommandError("رقم الهاتف مستخدم لحساب آخر من النوع نفسه", 409); }
    const party = { id: id("party"), name, phone, partyType, receivable: 0, payable: 0, net: 0, createdAt: new Date() };
    await db.collection("parties").insertOne(party, { session }); return party.id;
  }
  if (type === "party.update") {
    const partyId=text(body.id),party=await db.collection("parties").findOne({id:partyId,isArchived:{$ne:true}},{session});
    if(!party)throw new CommandError("الطرف غير موجود",404);
    const name=text(body.name),phone=text(body.phone),partyType=resolvePartyType(party);
    if(!name)throw new CommandError("اسم الحساب مطلوب");
    if(phone&&await db.collection("parties").findOne({phone,partyType,id:{$ne:partyId}},{session}))throw new CommandError("رقم الهاتف مستخدم لحساب آخر من النوع نفسه",409);
    await propagatePartyName(db,session,partyId,String(party.name??""),name);
    await db.collection("parties").updateOne({id:partyId},{$set:{name,phone,updatedAt:new Date()}},{session});
    return partyId;
  }
  if (type === "party.restore") {
    const partyId=text(body.id),party=await db.collection("parties").findOne({id:partyId,isArchived:true},{session});
    if(!party)throw new CommandError("الطرف المؤرشف غير موجود",404);
    await db.collection("parties").updateOne({id:partyId},{$set:{isArchived:false,archivedAt:null,updatedAt:new Date()}},{session});
    return partyId;
  }
  if (type === "party.delete") {
    const partyId=text(body.id),party=await db.collection("parties").findOne({id:partyId,isArchived:{$ne:true}},{session});
    if(!party)throw new CommandError("الطرف غير موجود",404);
    const rawReceivable=Number(party.receivable??0),rawPayable=Number(party.payable??0),receivable=Number.isFinite(rawReceivable)?Math.max(0,rawReceivable):0,payable=Number.isFinite(rawPayable)?Math.max(0,rawPayable):0;
    if(receivable>0||payable>0)throw new CommandError("لا يمكن حذف أو أرشفة الطرف ما دام لديه رصيد قائم. سوِّ الحساب أولاً.",409);
    const historicalReference=await db.collection("documents").findOne({partyId},{session})||await db.collection("financialMovements").findOne({partyId},{session});
    if(historicalReference){await db.collection("parties").updateOne({id:partyId},{$set:{isArchived:true,archivedAt:new Date(),updatedAt:new Date()}},{session});return {id:partyId,disposition:"archived"};}
    await db.collection("importMappings").deleteMany({targetEntityType:"parties",targetId:partyId},{session});
    await db.collection("parties").deleteOne({id:partyId},{session});
    return {id:partyId,disposition:"deleted"};
  }
  if (type === "warehouse.create") {
    const name = text(body.name); if (!name) throw new CommandError("اسم المخزن مطلوب"); const _id = id("wh");
    await warehouses(db).insertOne({ _id, name, isSalesDefault: false, createdAt: new Date() }, { session }); return _id;
  }
  if (type === "warehouse.update") { const name = text(body.name), warehouseId = text(body.id); if (!name) throw new CommandError("اسم المخزن مطلوب"); const warehouse=await warehouses(db).findOne({_id:warehouseId},{session});if(!warehouse)throw new CommandError("المخزن غير موجود",404);await propagateWarehouseName(db,session,warehouseId,String(warehouse.name??""),name);await warehouses(db).updateOne({_id:warehouseId},{$set:{name,updatedAt:new Date()}},{session});return warehouseId; }
  if (type === "warehouse.default") { const warehouseId = text(body.warehouseId); if (!await warehouses(db).findOne({ _id: warehouseId, isArchived: { $ne: true } }, { session })) throw new CommandError("المخزن غير موجود", 404); await warehouses(db).updateMany({}, { $set: { isSalesDefault: false } }, { session }); await warehouses(db).updateOne({ _id: warehouseId }, { $set: { isSalesDefault: true } }, { session }); return warehouseId; }
  if (type === "warehouse.delete") {
    const warehouseId=text(body.id), warehouse=await warehouses(db).findOne({_id:warehouseId},{session}); if(!warehouse)throw new CommandError("المخزن غير موجود",404);
    if(warehouse.isSalesDefault)throw new CommandError("عيّن مخزنًا آخر للبيع قبل حذف هذا المخزن",409);
    if(await db.collection("products").findOne({[`stocks.${warehouseId}`]:{$exists:true,$ne:0}},{session}))throw new CommandError("لا يمكن حذف مخزن يحتوي على مخزون",409);
    const referenced=await db.collection("documents").findOne({$or:[{warehouseId},{destinationWarehouseId:warehouseId}]},{session})||await db.collection("stockMovements").findOne({warehouseId},{session});
    if(referenced)await warehouses(db).updateOne({_id:warehouseId},{$set:{isArchived:true,archivedAt:new Date(),isSalesDefault:false}},{session});else await warehouses(db).deleteOne({_id:warehouseId},{session}); return warehouseId;
  }
  if (type === "product-category.create" || type === "product-category.update") {
    const categoryId = text(body.id), name = text(body.name);
    if (!name) throw new CommandError("اسم الفئة مطلوب");
    if (name.length > 80) throw new CommandError("اسم الفئة طويل جدًا");
    const duplicate = await db.collection("productCategories").findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" }, ...(type === "product-category.update" ? { id: { $ne: categoryId } } : {}) }, { session });
    if (duplicate) throw new CommandError("هذه الفئة موجودة بالفعل", 409);
    if (type === "product-category.update") {
      const result = await db.collection("productCategories").updateOne({ id: categoryId }, { $set: { name, updatedAt: new Date() } }, { session });
      if (!result.matchedCount) throw new CommandError("الفئة غير موجودة", 404);
      return categoryId;
    }
    const category = { id: id("category"), name, createdAt: new Date() };
    await db.collection("productCategories").insertOne(category, { session });
    return category.id;
  }
  if (type === "product-category.delete") {
    const categoryId = text(body.id), category = await db.collection("productCategories").findOne({ id: categoryId }, { session });
    if (!category) throw new CommandError("الفئة غير موجودة", 404);
    await db.collection("products").updateMany({ categoryId }, { $set: { categoryId: null } }, { session });
    await db.collection("productCategories").deleteOne({ id: categoryId }, { session });
    return categoryId;
  }
  if (type === "product.create" || type === "product.update") {
    const name = text(body.name), barcode = text(body.barcode);
    if (!name) throw new CommandError("اسم المنتج مطلوب");
    const productId = text(body.id), categoryId = text(body.categoryId);
    if (categoryId && !await db.collection("productCategories").findOne({ id: categoryId }, { session })) throw new CommandError("الفئة غير موجودة", 404);
    if (barcode && await db.collection("products").findOne({ barcode, ...(type === "product.update" ? { id: { $ne: productId } } : {}) }, { session })) throw new CommandError("هذا الباركود مستخدم لمنتج آخر", 409);
    const note = text(body.note);
    if (note.length > 1000) throw new CommandError("ملاحظة المنتج طويلة جدًا");
    const pieceCost = optionalNumber(body.pieceCost, "سعر الشراء"), values = { name, barcode, expiryDate: optionalDate(body.expiryDate), note: note || null, categoryId: categoryId || null, pieceCost, piecePrice: optionalNumber(body.piecePrice, "سعر البيع"), wholesalePrice: optionalNumber(body.wholesalePrice, "سعر الجملة") };
    if (type === "product.create") {
      const openingStock = optionalNumber(body.openingStock, "رصيد البداية") ?? 0;
      if (!Number.isInteger(openingStock)) throw new CommandError("رصيد البداية غير صالح");
      if (openingStock > 0 && (!pieceCost || pieceCost <= 0)) throw new CommandError("سعر الشراء للفرد مطلوب عند إدخال رصيد بداية");
      let warehouse = null;
      let openingWarehouseId: string | null = null;
      if (openingStock > 0) {
        openingWarehouseId = text(body.openingWarehouseId);
        if (!openingWarehouseId) throw new CommandError("مخزن رصيد البداية مطلوب");
        warehouse = await warehouses(db).findOne({ _id: openingWarehouseId, isArchived: { $ne: true } }, { session });
        if (!warehouse) throw new CommandError("مخزن رصيد البداية مطلوب");
      }
      const sku = await nextProductCode(db, session), now = new Date(), product = { id: id("product"), sku, ...values, openingStock, openingCost: openingStock > 0 ? pieceCost : null, openingWarehouseId, ...(openingStock > 0 ? { lastPurchaseCost: pieceCost, lastPurchaseAt: null, lastPurchaseCostSource: "opening" } : { lastPurchaseCost: null, lastPurchaseAt: null, lastPurchaseCostSource: null }), stocks: {}, createdAt: now };
      await db.collection("products").insertOne(product, { session });
      if (openingStock > 0 && warehouse) {
        const doc = { ...baseDocument("adjustment", "OPEN"), partyId: null, partyName: null, warehouseId: warehouse._id, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: null, title: "رصيد بداية", openingStockAfter: openingStock, openingCostAfter: pieceCost, total: 0, dueTotal: 0, paidTotal: 0, lines: [{ id: id("line"), productId: product.id, description: name, quantity: openingStock, unitPrice: pieceCost, lineTotal: 0 }] };
        await changeStock(db, session, product, warehouse, openingStock, doc, "opening");
        await db.collection("documents").insertOne(doc, { session });
      }
      return product.id;
    }
    const product=await db.collection("products").findOne({id:productId},{session}); if(!product)throw new CommandError("المنتج غير موجود",404);
    if(["decant","partial","bottle"].includes(String(product.perfumeForm??""))){await db.collection("products").updateOne({id:productId},{$set:{name,barcode,expiryDate:values.expiryDate,note:values.note,categoryId:values.categoryId,piecePrice:values.piecePrice,wholesalePrice:values.wholesalePrice}},{session});return productId;}
    const replaceOpeningStock = body.replaceOpeningStock === true;
    if (!replaceOpeningStock) {
      if (Number(body.openingStock ?? 0) > 0 && Number(body.openingStock) !== Number(product.openingStock ?? 0)) throw new CommandError("تعديل رصيد البداية يحتاج طلب تصحيح صريح", 409);
      await db.collection("products").updateOne({id:productId},{$set:values},{session});
      return productId;
    }
    const state = await deriveOpeningStockState(db, session, product);
    const openingStock = optionalNumber(body.openingStock,"رصيد البداية") ?? 0;
    if (!state.hasNativeOpening && (state.hasStockHistory || Object.values(product.stocks ?? {}).some(quantity => Number(quantity) !== 0)) && openingStock > 0) throw new CommandError("لا يمكن إنشاء رصيد بداية رجعي بعد وجود حركات مخزون. استخدم تصحيح المخزون بدلًا من ذلك.", 409);
    if(!Number.isInteger(openingStock))throw new CommandError("رصيد البداية غير صالح");
    const requestedOpeningCost = optionalNumber(body.openingCost, "تكلفة رصيد البداية") ?? state.cost ?? pieceCost;
    if(openingStock>0&&(!requestedOpeningCost||requestedOpeningCost<=0))throw new CommandError("تكلفة رصيد البداية مطلوبة");
    const openingWarehouseId = text(body.openingWarehouseId) || state.warehouseId;
    let targetWarehouse: WarehouseDoc | null = null;
    if (openingWarehouseId) targetWarehouse = await warehouses(db).findOne({ _id: openingWarehouseId, isArchived: { $ne: true } }, { session }) ?? null;
    const relocateOpeningStock = body.relocateOpeningStock === true;
    let plan;
    try { plan = planOpeningStockCorrection(state, openingStock, targetWarehouse?._id ?? openingWarehouseId ?? null, relocateOpeningStock); }
    catch (error) { throw new CommandError(error instanceof Error ? error.message : "رصيد البداية غير صالح", 409); }
    const openingCost = openingStock > 0 ? requestedOpeningCost : null;
    const costChanged = Number(state.cost ?? 0) !== Number(openingCost ?? 0);
    const warehouseChanged = Boolean(relocateOpeningStock && openingStock > state.consumed && openingWarehouseId !== state.warehouseId);
    if (plan.deltas.length || costChanged || warehouseChanged || !Number.isFinite(Number(product.openingStock))) {
      const correction = { ...baseDocument("adjustment", "OPEN-COR"), openingCorrection: true, openingStockBefore: state.total, openingStockAfter: openingStock, openingCostBefore: state.cost, openingCostAfter: openingCost, partyId: null, partyName: null, warehouseId: state.warehouseId, warehouseName: state.warehouseId ? (await warehouses(db).findOne({ _id: state.warehouseId }, { session }))?.name ?? null : null, destinationWarehouseId: targetWarehouse?._id ?? null, destinationWarehouseName: targetWarehouse?.name ?? null, parentDocumentId: null, paymentMethod: null, title: "تصحيح رصيد البداية", total: 0, dueTotal: 0, paidTotal: 0, lines: [] as Record<string, unknown>[] };
      for (const item of plan.deltas) {
        const warehouse = item.delta > 0 ? await warehouses(db).findOne({ _id: item.warehouseId, isArchived: { $ne: true } }, { session }) : await warehouses(db).findOne({ _id: item.warehouseId }, { session });
        if (!warehouse || String(warehouse._id) !== item.warehouseId) throw new CommandError(item.delta > 0 ? "مخزن رصيد البداية غير متاح" : "تعذر تحديد مخزن رصيد البداية", 409);
        try { await changeStock(db, session, product, warehouse, item.delta, correction, "opening-correction"); }
        catch (error) { if (error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("تعذر تصحيح رصيد البداية لأن الرصيد الحالي لا يطابق سجل الحركات. راجع حركة المنتج أولًا.", 409); throw error; }
        correction.lines.push({ id: id("line"), productId, description: `${name} — ${warehouse.name}`, quantity: item.delta, unitPrice: openingCost ?? state.cost ?? 0, lineTotal: 0 });
      }
      if (!correction.lines.length) correction.lines.push({ id: id("line"), productId, description: `${name} — تصحيح تكلفة رصيد البداية`, quantity: 0, unitPrice: openingCost ?? 0, lineTotal: 0 });
      await db.collection("documents").insertOne(correction,{session});
    }
    await db.collection("products").updateOne({id:productId},{$set:{...values,openingStock,openingCost,openingWarehouseId:openingStock>state.consumed?(targetWarehouse?._id??state.warehouseId):state.warehouseId??targetWarehouse?._id??null}},{session});
    await recomputePurchaseCosts(db,session,[productId]);
    return productId;
  }
  if (["sale.update", "purchase.update"].includes(type)) {
    const kind = type.startsWith("sale") ? "sale" : "purchase", isSale = kind === "sale", documentId = text(body.documentId);
    const original = await db.collection("documents").findOne({ id: documentId, kind, status: "posted" }, { session });
    if (!original) throw new CommandError("الفاتورة غير موجودة أو غير قابلة للتعديل", 404);
    if (original.legacyKey) throw new CommandError("الفواتير المرحلة متاحة للعرض فقط", 409);
    if (isSale && await db.collection("documents").findOne({ kind: "return", status: "posted", parentDocumentId: documentId }, { session })) throw new CommandError("لا يمكن تعديل هذه الفاتورة القديمة لوجود حركة تاريخية مرتبطة بها.", 409);
    const input = lines(body), paymentMethod = text(body.paymentMethod);
    const updateBody={...body,warehouseId:isSale?original.warehouseId:body.warehouseId};
    const { warehouse, party, warehouseId, partyId } = await invoiceUpdateRefs(db, session, updateBody, original, paymentMethod === "note");
    const preserveOriginalPartyArchive=Boolean(party&&partyId===String(original.partyId??"")&&party.isArchived===true),originalPartyArchivedAt=party?.archivedAt;
    if (party && party.partyType !== (isSale ? "customer" : "supplier")) throw new CommandError(isSale ? "يجب اختيار عميل صالح" : "يجب اختيار مورد صالح");
    const historicalPayment = paymentMethod !== "note" ? await paymentAccountForHistoricalEdit(db, session, paymentMethod, original.paymentMethod) : null;
    const oldLines = original.lines as Line[],oldProductIds=new Set(oldLines.map(line=>String(line.productId))),newProducts=await productsForUpdate(db,session,input,oldProductIds), oldByProduct = new Map(oldLines.map(line => [line.productId, line]));
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
      for (const old of oldLines) try { await changeStock(db, session, productMap.get(old.productId)!, oldWarehouse, -old.quantity, { ...original, occurredAt: new Date().toISOString(), revision: Number(original.revision ?? 0) + 1 }, "purchase-edit-reversal"); } catch (error) { if (error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن تعديل الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
      for (const line of input) await changeStock(db, session, productMap.get(line.productId)!, warehouse, line.quantity, { ...original, occurredAt: new Date().toISOString(), revision: Number(original.revision ?? 0) + 1 }, "purchase-edit");
    } else {
      const oldQuantity = new Map(oldLines.map(line => [line.productId, line.quantity]));
      for (const productId of allIds) {
        const delta = isSale ? (oldQuantity.get(productId) ?? 0) - (newByProduct.get(productId) ?? 0) : (newByProduct.get(productId) ?? 0) - (oldQuantity.get(productId) ?? 0);
        if (!delta) continue;
        try { await changeStock(db, session, productMap.get(productId)!, warehouse, delta, { ...original, occurredAt: new Date().toISOString(), revision: Number(original.revision ?? 0) + 1 }, `${kind}-edit`); } catch (error) { if (!isSale && error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن تعديل الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
      }
    }
    if (Number(original.dueTotal) > 0) await changePartyDebt(db, session, original.partyId, kind, -Number(original.dueTotal), true);
    await reverseInvoicePayment(db, session, original, kind);
    if (historicalPayment) await reactivateHistoricalPaymentAccount(db, session, historicalPayment.account, historicalPayment.sameOriginal);
    const partyEffect = party ? (isSale ? dueTotal : -dueTotal) : 0;
    const snapshot = party ? await applyPartyNetDelta(db, session, partyId, partyEffect) : null;
    const revised = { partyId: partyId || null, partyName: party?.name ?? (isSale ? "بيع مباشر" : "شراء مباشر"), warehouseId, warehouseName: warehouse.name, paymentMethod, total, paidTotal, cashAmount: paidTotal, dueTotal, lines: calculated, ...(snapshot ? { partyBalanceBefore: snapshot.before, partyBalanceDelta: snapshot.delta, partyBalanceAfter: snapshot.after } : {}), ...(isSale ? { pricingMode: body.pricingMode === "wholesale" ? "wholesale" : "retail" } : {}), updatedAt: new Date(), revision: Number(original.revision ?? 0) + 1 };
    await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: revised, ...(!snapshot ? { $unset: { partyBalanceBefore: "", partyBalanceDelta: "", partyBalanceAfter: "" } } : {}) }, { session });
    if (paidTotal) await financialMovement(db, session, { ...original, ...revised }, isSale ? "in" : "out", paidTotal, kind);
    if(partyId===String(original.partyId??""))await preserveHistoricalPartyArchiveIfBalanced(db,session,partyId,preserveOriginalPartyArchive,originalPartyArchivedAt);
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
    for (const line of oldLines) try { await changeStock(db, session, map.get(line.productId)!, warehouse, isSale ? line.quantity : -line.quantity, { ...original, occurredAt: new Date().toISOString(), revision: Number(original.revision ?? 0) + 1 }, `${kind}-void`); } catch (error) { if (!isSale && error instanceof CommandError && /المخزون غير كاف/.test(error.message)) throw new CommandError("لا يمكن حذف الفاتورة لأن جزءًا من مخزونها تم التصرف فيه.", 409); throw error; }
    if (Number(original.dueTotal) > 0) await changePartyDebt(db, session, original.partyId, kind, -Number(original.dueTotal), true);
    await reverseInvoicePayment(db, session, original, kind);
    await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date(), revision: Number(original.revision ?? 0) + 1 } }, { session });
    if (!isSale) await recomputePurchaseCosts(db, session, oldLines.map(line => line.productId));
    return documentId;
  }
  if (type === "sale.post" || type === "purchase.post") {
    const input = lines(body), isSale = type === "sale.post", { warehouse, party, warehouseId, partyId } = await refs(db, session, body, text(body.paymentMethod) === "note"), map = await products(db, session, input), paymentMethod = text(body.paymentMethod);
    if(partyId&&!party)throw new CommandError(isSale?"يجب اختيار عميل صالح":"يجب اختيار مورد صالح",404);
    if (party && party.partyType !== (isSale ? "customer" : "supplier")) throw new CommandError(isSale ? "يجب اختيار عميل صالح" : "يجب اختيار مورد صالح");
    if(isSale&&input.some(line=>["decant","bottle"].includes(String(map.get(line.productId)?.perfumeForm??""))))throw new CommandError("عطر التقسيمات وزجاجه يُباعان من فاتورة التقسيمات فقط",409);
    if(!isSale&&input.some(line=>["decant","partial","bottle"].includes(String(map.get(line.productId)?.perfumeForm??""))))throw new CommandError("التقسيمات المولدة وزجاجها لا تُشترى من فاتورة الشراء العادية",409);
    if (isSale && input.some(line => isProductExpired(map.get(line.productId)!, new Date().toISOString().slice(0, 10)))) throw new CommandError("انتهت صلاحية هذا المنتج ولا يمكن بيعه.");
    if (paymentMethod !== "note") await paymentAccount(db, session, paymentMethod);
    const costs = isSale ? new Map(await Promise.all(input.map(async line => [line.productId, await authoritativeCost(db, session, map.get(line.productId)!)] as const))) : new Map<string, number | null>();
    const calculated = input.map(line => { const p = map.get(line.productId)!; let unitPrice: number, total: number; if (isSale) { const price = positive(line.piecePrice, "سعر الفرد"); total = Math.round(line.quantity * price); unitPrice = price; } else { unitPrice = positive(line.unitPrice, "سعر الشراء"); total = Math.round(unitPrice * line.quantity); } return { id: id("line"), productId: line.productId, description: p.name, quantity: line.quantity, unitPrice, lineTotal: total, ...(isSale ? { costAtSale: costs.get(line.productId) ?? null, grossProfit: costs.get(line.productId) == null ? null : total - line.quantity * Number(costs.get(line.productId)) } : {}) }; });
    const total = calculated.reduce((s, l) => s + l.lineTotal, 0);
    const suppliedCash = body.cashAmount ?? body.paidAmount;
    const settlementAmount = suppliedCash == null || suppliedCash === "" ? (paymentMethod === "note" ? 0 : total) : positive(suppliedCash, isSale ? "المبلغ المستلم" : "المبلغ المدفوع", true);
    if (paymentMethod === "note" ? settlementAmount !== 0 : settlementAmount !== total) throw new CommandError("الدفع الجزئي داخل الفاتورة غير مدعوم. الفاتورة إما مدفوعة بالكامل أو ملاحظة بالكامل، ثم تُسجل أي دفعة لاحقة من حساب الطرف.", 409);
    const cashAmount = paymentMethod === "note" ? 0 : total, paidTotal = cashAmount, due = paymentMethod === "note" ? total : 0, partyDelta = isSale ? due : -due;
    if (due && !party) throw new CommandError(isSale ? "اختر عميلاً عند وجود مبلغ مستحق" : "اختر موردًا عند وجود مبلغ مستحق");
    const businessDate = new Date().toISOString().slice(0, 10);
    const dailySequence = isSale ? (Number((await db.collection("documents").find({ kind: "sale", businessDate }, { session }).sort({ dailySequence: -1 }).limit(1).next())?.dailySequence ?? 0) + 1) : undefined;
    const pricingMode = body.pricingMode === "wholesale" ? "wholesale" : "retail";
    const snapshot = partyDelta ? await applyPartyNetDelta(db, session, partyId, partyDelta) : null;
    const doc = { ...await numberedDocument(db, session, isSale ? "sale" : "purchase", isSale ? "SAL" : "PUR"), revision: 0, businessDate, ...(isSale ? { dailySequence, pricingMode } : {}), partyId: partyId || null, partyName: party?.name ?? (isSale ? "بيع مباشر" : "شراء مباشر"), warehouseId, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod, title: null, total, dueTotal: due, paidTotal, cashAmount, ...(snapshot ? { partyBalanceBefore:snapshot.before, partyBalanceDelta:snapshot.delta, partyBalanceAfter:snapshot.after } : {}), lines: calculated };
    for (const line of input) await changeStock(db, session, map.get(line.productId)!, warehouse, isSale ? -line.quantity : line.quantity, doc, isSale ? "sale" : "purchase");
    await db.collection("documents").insertOne(doc, { session });
    if (!isSale) for (const line of calculated) await db.collection("products").updateOne({ id: line.productId }, { $set: { lastPurchaseCost: line.unitPrice, lastPurchaseAt: doc.occurredAt, lastPurchaseCostSource: "purchase" } }, { session });
    if (cashAmount) await financialMovement(db, session, doc, isSale ? "in" : "out", cashAmount, isSale ? "sale" : "purchase");
    return doc.id;
  }
  if (type === "transfer.post") {
    const input = lines(body), fromId = text(body.fromWarehouseId), toId = text(body.toWarehouseId); if (!fromId || fromId === toId) throw new CommandError("اختر مخزنين مختلفين");
    const [from, to] = await Promise.all([warehouses(db).findOne({ _id: fromId, isArchived: { $ne: true } }, { session }), warehouses(db).findOne({ _id: toId, isArchived: { $ne: true } }, { session })]); if (!from || !to) throw new CommandError("أحد المخازن غير موجود", 404); const map = await products(db, session, input), doc = { ...baseDocument("transfer", "TRF"), revision: 0, partyId: null, partyName: null, warehouseId: fromId, warehouseName: from.name, destinationWarehouseId: toId, destinationWarehouseName: to.name, parentDocumentId: null, paymentMethod: null, title: null, total: 0, dueTotal: 0, paidTotal: 0, lines: input.map(l => ({ id: id("line"), productId: l.productId, description: map.get(l.productId)!.name, quantity: l.quantity, unitPrice: 0, lineTotal: 0 })) };
    for (const line of input) { const p = map.get(line.productId)!; if(p.perfumeForm==="decant")await transferPerfumeLots(db,session,p,fromId,toId,line.quantity); await changeStock(db, session, p, from, -line.quantity, doc, "transfer-out"); await changeStock(db, session, p, to, line.quantity, doc, "transfer-in"); } await db.collection("documents").insertOne(doc, { session }); return doc.id;
  }
  if (type === "adjustment.post") {
    if (!Array.isArray(body.lines) || !body.lines.length) throw new CommandError("أضف منتجًا");
    const input = body.lines.map(raw => {
      const r = raw as Input, productId = text(r.productId);
      if (!productId) throw new CommandError("المنتج غير صالح");
      return { productId, quantity: 1, actualQuantity: positive(r.actualQuantity, "الرصيد الفعلي", true) };
    });
    const { warehouse, warehouseId } = await refs(db, session, body), map = await products(db, session, input), reason = text(body.reason);
    if (!reason) throw new CommandError("سبب التصحيح مطلوب");
    if(input.some(line=>["decant","partial"].includes(String(map.get(line.productId)?.perfumeForm??""))))throw new CommandError("لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا",409);
    const costs = new Map<string, number | null>();
    for (const line of input) {
      const product = map.get(line.productId)!;
      const stocks = (product.stocks ?? {}) as Record<string, number>;
      const before = Number(stocks[warehouseId] ?? 0);
      const hasWarehouseField = Object.prototype.hasOwnProperty.call(stocks, warehouseId);
      const hasWarehouseMovement = hasWarehouseField ? true : Boolean(await db.collection("stockMovements").findOne({ productId: product.id, warehouseId }, { session }));
      if (!hasWarehouseMovement) throw new CommandError(`لا يمكن تصحيح مخزون المنتج ${product.name} في هذا المخزن قبل دخوله إليه عبر رصيد بداية أو شراء أو تحويل مخزون.`, 409);
      const cost = await authoritativeCost(db, session, product);
      costs.set(line.productId, cost);
      if (line.actualQuantity! > before && cost == null) throw new CommandError(`لا يمكن زيادة مخزون المنتج ${product.name} بالتصحيح لأنه لا يملك رصيد بداية أو فاتورة شراء قائمة تحدد تكلفته.`, 409);
    }
    const effectiveInput = input.filter(line => line.actualQuantity !== Number((map.get(line.productId)!.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0));
    if (!effectiveInput.length) throw new CommandError("لا يوجد تغيير في المخزون لاعتماده", 409);
    const doc = { ...baseDocument("adjustment", "ADJ"), revision: 0, partyId: null, partyName: null, warehouseId, warehouseName: warehouse.name, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: null, title: reason, total: 0, dueTotal: 0, paidTotal: 0, lines: [] as Record<string, unknown>[] };
    for (const line of effectiveInput) {
      const p = map.get(line.productId)!, before = Number((p.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0), after = line.actualQuantity!;
      await changeStock(db, session, p, warehouse, after - before, doc, "adjustment");
      doc.lines.push({ id: id("line"), productId: line.productId, description: `${p.name} — ${reason} (قبل ${before}، بعد ${after})`, quantity: after - before, unitPrice: Number(costs.get(line.productId) ?? 0), lineTotal: 0, balanceBefore: before, balanceAfter: after });
    }
    await db.collection("documents").insertOne(doc, { session });
    return doc.id;
  }
  if (["payment.post","settlement.post","offset.post"].includes(type)) throw new CommandError("هذا المسار المحاسبي القديم متاح للقراءة فقط؛ استخدم دورة الحركات الحالية.",409);
  if (type === "expense.post") { const title = text(body.title), amount = positive(body.amount, "المبلغ"), date = text(body.occurredAt), parsedDate = new Date(`${date}T12:00:00Z`); if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0,10) !== date) throw new CommandError("العنوان والتاريخ غير صالحين"); const method = text(body.paymentMethod); await paymentAccount(db, session, method); const doc = { ...await numberedDocument(db, session, "expense", "EXP"), revision: 0, occurredAt: parsedDate.toISOString(), partyId: null, partyName: null, warehouseId: null, warehouseName: null, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: method, title, total: amount, dueTotal: 0, paidTotal: amount, cashAmount: amount, lines: [{ id: id("line"), productId: null, description: title, quantity: 1, unitPrice: amount, lineTotal: amount }] }; await financialMovement(db, session, doc, "out", amount, "expense"); await db.collection("documents").insertOne(doc, { session }); return doc.id; }
  if (type === "expense.update") {
    const documentId=text(body.documentId),title=text(body.title),amount=positive(body.amount,"المبلغ"),date=text(body.occurredAt),method=text(body.paymentMethod),parsedDate=new Date(`${date}T12:00:00Z`);
    if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(parsedDate.valueOf())||parsedDate.toISOString().slice(0,10)!==date)throw new CommandError("العنوان والتاريخ غير صالحين");
    const original=await db.collection("documents").findOne({id:documentId,kind:"expense",status:"posted"},{session});
    if(!original||original.legacyKey)throw new CommandError("المصروف غير موجود أو غير قابل للتعديل",404);
    const historicalPayment=await paymentAccountForHistoricalEdit(db,session,method,original.paymentMethod);
    const movement=await findActiveFinancialMovement(db,session,{documentId,type:"expense"});
    if(!movement)throw new CommandError("تعذر العثور على حركة المصروف الأصلية",409);
    await reverseFinancialMovement(db,session,movement,"تعديل مصروف");
    await reactivateHistoricalPaymentAccount(db,session,historicalPayment.account,historicalPayment.sameOriginal);
    const occurredAt=parsedDate.toISOString(),lineId=(original.lines as Line[]|undefined)?.[0]?.id??id("line");
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
    const movement=await findActiveFinancialMovement(db,session,{documentId,type:"expense"});
    if(!movement)throw new CommandError("تعذر العثور على حركة المصروف الأصلية",409);
    await reverseFinancialMovement(db,session,movement,"إلغاء مصروف");
    await db.collection("documents").updateOne({id:documentId,kind:"expense",status:"posted"},{$set:{status:"voided",voidedAt:new Date(),updatedAt:new Date()},$inc:{revision:1}},{session});
    return documentId;
  }
  if (type === "payment-account.create") { const name = text(body.name), openingBalance = num(body.openingBalance ?? 0); if (!name) throw new CommandError("اسم البنك أو وسيلة الدفع مطلوب");if(!Number.isFinite(openingBalance))throw new CommandError("رصيد البداية غير صالح"); const account = { id: id("account"), code: id("custom"), name, color: "#1677c8", icon: "wallet", isActive: true, allowNegativeBalance: true, openingBalance, balance: 0, createdAt: new Date() }; await db.collection("paymentAccounts").insertOne(account, { session }); if (openingBalance !== 0) { const doc = { ...baseDocument("opening-balance", "OPEN"), revision: 0, paymentMethod: account.id, partyId: null, partyName: null, note: "رصيد بداية" }; await financialMovement(db, session, doc, openingBalance>=0?"in":"out", Math.abs(openingBalance), "opening-balance"); } return account.id; }
  if(type==="payment-account.delete"){const account=await paymentAccount(db,session,body.accountId,false);if(account.code==="cash")throw new CommandError("لا يمكن حذف وسيلة الدفع النقدية الأساسية",409);if(Number(account.balance??0)!==0)throw new CommandError("لا يمكن حذف أو أرشفة وسيلة الدفع ورصيدها غير صفري. صفّر أو سوِّ الرصيد أولًا.",409);const key=[account.id,account.code], [movement,document,transfer]=await Promise.all([db.collection("financialMovements").findOne({paymentMethod:{$in:key}},{session}),db.collection("documents").findOne({paymentMethod:{$in:key}},{session}),db.collection("accountTransfers").findOne({$or:[{fromAccountId:{$in:key}},{toAccountId:{$in:key}}]},{session})]);if(movement||document||transfer){await db.collection("paymentAccounts").updateOne({id:account.id},{$set:{isActive:false,isArchived:true,archivedAt:new Date(),updatedAt:new Date()}},{session});return {id:String(account.id),disposition:"archived"}}await db.collection("paymentAccounts").deleteOne({id:account.id},{session});return {id:String(account.id),disposition:"deleted"}}
  if(type==="payment-account.restore"){const account=await paymentAccount(db,session,body.accountId,false);if(account.code==="cash"||account.isArchived!==true)throw new CommandError("وسيلة الدفع غير مؤرشفة",409);await db.collection("paymentAccounts").updateOne({id:account.id,isArchived:true},{$set:{isArchived:false,isActive:true,archivedAt:null,updatedAt:new Date()}},{session});return String(account.id)}
  if(type==="account-opening-balance-correction.post"){const account=await paymentAccount(db,session,body.accountId,false),newOpening=num(body.newOpeningBalance),reason=text(body.reason);if(!Number.isFinite(newOpening))throw new CommandError("رصيد البداية الصحيح غير صالح");if(!reason)throw new CommandError("سبب التصحيح مطلوب");return postOpeningCorrection(db,session,account,newOpening,reason)}
  if(type==="account-opening-balance-correction.update"){const movementId=text(body.movementId??body.documentId),newOpening=num(body.newOpeningBalance),reason=text(body.reason);if(!movementId||!Number.isFinite(newOpening))throw new CommandError("بيانات تصحيح رصيد البداية غير صالحة");if(!reason)throw new CommandError("سبب التصحيح مطلوب");const {original,account,before,after}=await requireLatestOpeningCorrection(db,session,movementId);await reverseFinancialMovement(db,session,original,"تعديل تصحيح رصيد البداية");const reset=await db.collection("paymentAccounts").updateOne({id:account.id,openingBalance:after},{$set:{openingBalance:before,updatedAt:new Date()}},{session});if(!reset.matchedCount)throw new CommandError("تغير رصيد البداية أثناء العملية، أعد المحاولة",409);const fresh=await paymentAccount(db,session,account.id,false);return postOpeningCorrection(db,session,fresh,newOpening,reason,String(original.id),Number(original.revision??0)+1)}
  if(type==="account-opening-balance-correction.void"){const movementId=text(body.movementId??body.documentId);if(!movementId)throw new CommandError("تصحيح رصيد البداية غير صالح");const {original,account,before,after}=await requireLatestOpeningCorrection(db,session,movementId);await reverseFinancialMovement(db,session,original,"إلغاء تصحيح رصيد البداية");const reset=await db.collection("paymentAccounts").updateOne({id:account.id,openingBalance:after},{$set:{openingBalance:before,updatedAt:new Date()}},{session});if(!reset.matchedCount)throw new CommandError("تغير رصيد البداية أثناء العملية، أعد المحاولة",409);return movementId}
  throw new CommandError("العملية غير مدعومة");
}

