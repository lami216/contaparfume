import type { SqliteDatabase as Db, SqliteSession as ClientSession } from "./sqlite.ts";
import { normalizePartyNet, partyCashDelta, partyNet } from "../app/party-balance.ts";

export class LifecycleCommandError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

type Input = Record<string, unknown>;
type Stored = Record<string, unknown>;
type Direction = "in" | "out";

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const number = (value: unknown) => typeof value === "number" ? value : Number(value);
const positive = (value: unknown, label: string, allowZero = false) => {
  const numeric = number(value);
  if (!Number.isFinite(numeric) || (allowZero ? numeric < 0 : numeric <= 0)) throw new LifecycleCommandError(`${label} غير صالح`);
  return numeric;
};
const baseDocument = (kind: string, prefix: string) => ({
  id: id(kind), number: `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, kind, status: "posted", revision: 0, occurredAt: new Date().toISOString(),
});

async function paymentAccount(db: Db, session: ClientSession, value: unknown, active = true) {
  const key = text(value);
  const account = await db.collection("paymentAccounts").findOne({ $or: [{ id: key }, { code: key }], ...(active ? { isActive: true, isArchived: { $ne: true } } : {}) }, { session });
  if (!account) throw new LifecycleCommandError("يجب اختيار وسيلة دفع صالحة");
  return account;
}
async function paymentAccountForHistoricalEdit(db: Db, session: ClientSession, value: unknown, originalValue: unknown) {
  const account = await paymentAccount(db, session, value, false), originalKey = text(originalValue);
  const sameOriginal = Boolean(originalKey) && (String(account.id) === originalKey || String(account.code ?? "") === originalKey);
  if (!sameOriginal && (account.isActive !== true || account.isArchived === true)) throw new LifecycleCommandError("يجب اختيار وسيلة دفع صالحة");
  return { account, sameOriginal };
}
async function reactivateHistoricalPaymentAccount(db: Db, session: ClientSession, account: Stored, sameOriginal: boolean) {
  if (!sameOriginal || (account.isActive === true && account.isArchived !== true)) return;
  await db.collection("paymentAccounts").updateOne({ id: account.id }, { $set: { isActive: true, isArchived: false, archivedAt: null, updatedAt: new Date() } }, { session });
}

async function applyPartyNetDelta(db: Db, session: ClientSession, partyId: unknown, delta: number, reversing = false) {
  const party = await db.collection("parties").findOne({ id: String(partyId) }, { session });
  if (!party) { if (reversing) throw new LifecycleCommandError("لا يمكن تعديل رصيد الطرف", 409); return null; }
  const before = partyNet(party as { receivable?: unknown; payable?: unknown });
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
async function preserveHistoricalWarehouseArchiveIfEmpty(db:Db,session:ClientSession,warehouseId:string,wasArchived:boolean,archivedAt:unknown){
  if(!wasArchived)return;
  const occupied=await db.collection("products").findOne({[`stocks.${warehouseId}`]:{$exists:true,$ne:0}},{session});
  if(occupied)return;
  await db.collection("warehouses").updateOne({_id:warehouseId},{$set:{isArchived:true,isSalesDefault:false,archivedAt:archivedAt??new Date(),updatedAt:new Date()}},{session});
}

export async function postFinancialMovement(db: Db, session: ClientSession, document: Stored, direction: Direction, amount: number, type: string) {
  if (!amount) return null;
  const account = await paymentAccount(db, session, document.paymentMethod);
  const delta = direction === "in" ? amount : -amount;
  const changed = await db.collection("paymentAccounts").updateOne({ id: account.id }, { $inc: { balance: delta } }, { session });
  if (!changed.matchedCount) throw new LifecycleCommandError(`تعذر تحديث الرصيد في ${account.name}`, 409);
  const movement = {
    id: id("fin"), paymentMethod: account.id, paymentCode: account.code, direction, amount,
    documentId: document.id, documentNumber: document.number, partyId: document.partyId ?? null,
    partyName: document.partyName ?? null, type, occurredAt: document.occurredAt,
    transferId: document.transferId ?? null, note: document.note ?? null, status: "posted", revision: Number(document.revision ?? 0),
  };
  await db.collection("financialMovements").insertOne(movement, { session });
  return movement;
}

export async function findActiveFinancialMovement(db: Db, session: ClientSession, query: Stored) {
  return db.collection("financialMovements").findOne({ ...query, status: { $ne: "reversed" }, isReversal: { $ne: true } }, { session });
}

export async function reverseFinancialMovement(db: Db, session: ClientSession, movement: Stored, reason: string) {
  if (!movement || movement.status === "reversed" || movement.isReversal === true) throw new LifecycleCommandError("الحركة المالية ملغاة أو غير قابلة للعكس", 409);
  const amount = Number(movement.amount ?? 0), direction = movement.direction === "out" ? "out" : "in";
  if (!Number.isFinite(amount) || amount <= 0) throw new LifecycleCommandError("الحركة المالية الأصلية غير صالحة", 409);
  const account = await paymentAccount(db, session, movement.paymentMethod, false);
  const reverseDirection: Direction = direction === "in" ? "out" : "in";
  const delta = reverseDirection === "in" ? amount : -amount;
  const resultingBalance=Number(account.balance??0)+delta;
  const changed = await db.collection("paymentAccounts").updateOne({ id: account.id }, { $inc: { balance: delta }, ...(account.isArchived===true&&resultingBalance!==0?{$set:{isArchived:false,isActive:true,archivedAt:null,updatedAt:new Date()}}:{}) }, { session });
  if (!changed.matchedCount) throw new LifecycleCommandError("تعذر عكس الحركة المالية", 409);
  const now = new Date(), reversalId = id("fin");
  const reversed = await db.collection("financialMovements").updateOne(
    { _id: movement._id, status: { $ne: "reversed" } },
    { $set: { status: "reversed", reversedAt: now, reversalMovementId: reversalId, reversalReason: reason } },
    { session },
  );
  if (!reversed.matchedCount) throw new LifecycleCommandError("تم تغيير الحركة المالية أثناء العملية، أعد المحاولة", 409);
  await db.collection("financialMovements").insertOne({
    id: reversalId, paymentMethod: account.id, paymentCode: movement.paymentCode ?? account.code,
    direction: reverseDirection, amount, documentId: movement.documentId ?? null,
    documentNumber: movement.documentNumber ?? null, partyId: movement.partyId ?? null,
    partyName: movement.partyName ?? null, type: `${String(movement.type ?? "movement")}:reversal`,
    occurredAt: now.toISOString(), transferId: movement.transferId ?? null, note: reason,
    status: "posted", isReversal: true, reversalOfMovementId: movement.id ?? movement._id,
  }, { session });
  return reversalId;
}

export async function propagatePartyName(db: Db, session: ClientSession, partyId: string, previousName: string, currentName: string) {
  if (!currentName || previousName === currentName) return;
  for (const collectionName of ["documents", "financialMovements"] as const) {
    const collection = db.collection(collectionName);
    await collection.updateMany({ partyId, partyNameOriginal: { $exists: false } }, { $set: { partyNameOriginal: previousName || null } }, { session });
    await collection.updateMany({ partyId }, { $set: { partyName: currentName, partyNameUpdatedAt: new Date() } }, { session });
  }
}

async function changeStock(db: Db, session: ClientSession, product: Stored, warehouse: Stored, delta: number, document: Stored, type: string) {
  const warehouseId = String(warehouse._id), productId = String(product.id);
  const before = Number((product.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0), after = before + delta;
  if (after < 0) throw new LifecycleCommandError(`المخزون غير كافٍ للمنتج ${product.name}`);
  const stockPath = `stocks.${warehouseId}`;
  const stockMatch = before === 0 ? { $or: [{ [stockPath]: 0 }, { [stockPath]: { $exists: false } }] } : { [stockPath]: before };
  const changed = await db.collection("products").updateOne({ id: productId, ...stockMatch }, { $set: { [stockPath]: after } }, { session });
  if (!changed.matchedCount) throw new LifecycleCommandError("تغير المخزون أثناء العملية، أعد المحاولة", 409);
  const currentStocks = (product.stocks ??= {}) as Record<string, number>;
  currentStocks[warehouseId] = after;
  if (after !== 0 && warehouse.isArchived === true) {
    await db.collection("warehouses").updateOne({ _id: warehouseId, isArchived: true }, { $set: { isArchived: false, archivedAt: null, updatedAt: new Date() } }, { session });
    warehouse.isArchived = false;
  }
  await db.collection("stockMovements").insertOne({
    id: id("mov"), documentId: document.id, documentNumber: document.number, warehouseId,
    warehouseName: warehouse.name, productId, productName: product.name, type, quantityDelta: delta,
    balanceBefore: before, balanceAfter: after, occurredAt: document.occurredAt,
    documentRevision: Number(document.revision ?? 0),
  }, { session });
  return { before, after };
}

const parseTransferLines = (body: Input) => {
  if (!Array.isArray(body.lines) || !body.lines.length) throw new LifecycleCommandError("يجب إضافة منتج واحد على الأقل");
  const seen = new Set<string>();
  return body.lines.map(raw => {
    const record = raw as Input, productId = text(record.productId), quantity = positive(record.quantity, "الكمية");
    if (!productId || seen.has(productId)) throw new LifecycleCommandError("المنتجات غير صالحة أو مكررة");
    seen.add(productId); return { productId, quantity };
  });
};

async function loadProducts(db: Db, session: ClientSession, productIds: string[], activeOnly = false) {
  const rows = await db.collection("products").find({ id: { $in: productIds }, ...(activeOnly ? { isArchived: { $ne: true } } : {}) }, { session }).toArray();
  if (rows.length !== new Set(productIds).size) throw new LifecycleCommandError("أحد المنتجات غير موجود", 409);
  return new Map(rows.map(row => [String(row.id), row]));
}

const stockAuditDocument = (document: Stored, revision: number) => ({ ...document, revision, occurredAt: new Date().toISOString() });
const openingAdjustment = (document: Stored) => document.openingCorrection === true || String(document.number ?? "").startsWith("OPEN") || document.title === "رصيد بداية" || document.title === "تصحيح رصيد البداية";

async function updateTransfer(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "transfer", status: "posted" }, { session });
  if (!original) throw new LifecycleCommandError("تحويل المخزون غير موجود أو ملغى", 404);
  const oldFrom = await db.collection("warehouses").findOne({ _id: String(original.warehouseId) }, { session });
  const oldTo = await db.collection("warehouses").findOne({ _id: String(original.destinationWarehouseId) }, { session });
  if (!oldFrom || !oldTo) throw new LifecycleCommandError("تعذر تحديد مخازن التحويل الأصلية", 409);
  const oldFromWasArchived=oldFrom.isArchived===true,oldFromArchivedAt=oldFrom.archivedAt,oldToWasArchived=oldTo.isArchived===true,oldToArchivedAt=oldTo.archivedAt;
  const input = parseTransferLines(body), fromId = text(body.fromWarehouseId), toId = text(body.toWarehouseId);
  if (!fromId || !toId || fromId === toId) throw new LifecycleCommandError("اختر مخزنين مختلفين");
  const [from, to] = await Promise.all([
    db.collection("warehouses").findOne({ _id: fromId, ...(fromId===String(original.warehouseId)?{}:{isArchived:{ $ne:true }}) }, { session }),
    db.collection("warehouses").findOne({ _id: toId, ...(toId===String(original.destinationWarehouseId)?{}:{isArchived:{ $ne:true }}) }, { session }),
  ]);
  if (!from || !to) throw new LifecycleCommandError("أحد المخازن غير موجود", 404);

  const oldLines = (original.lines ?? []) as Stored[], oldIds = oldLines.map(line => String(line.productId)), requestedIds=input.map(line=>line.productId);
  const allIds=[...new Set([...oldIds,...requestedIds])],products=await loadProducts(db,session,allIds);
  for(const productId of requestedIds){const product=products.get(productId)!;if(product.isArchived===true&&!oldIds.includes(productId))throw new LifecycleCommandError("لا يمكن إضافة منتج محذوف إلى تحويل مخزون",409)}
  const revision = Number(original.revision ?? 0) + 1, audit = stockAuditDocument(original, revision);
  const warehouseMap=new Map([[String(oldFrom._id),oldFrom],[String(oldTo._id),oldTo],[String(from._id),from],[String(to._id),to]]);
  const deltas=new Map<string,{productId:string;warehouseId:string;delta:number}>();
  const addDelta=(productId:string,warehouseId:string,delta:number)=>{const key=`${productId}\u0000${warehouseId}`,current=deltas.get(key);deltas.set(key,{productId,warehouseId,delta:(current?.delta??0)+delta})};

  // Remove the old transfer effect and add the requested effect mathematically.
  // The resulting movement is the edit's net stock change, not an artificial full reversal + replay.
  for(const line of oldLines){const productId=String(line.productId),quantity=Number(line.quantity??0);addDelta(productId,String(oldFrom._id),quantity);addDelta(productId,String(oldTo._id),-quantity)}
  for(const line of input){addDelta(line.productId,fromId,-line.quantity);addDelta(line.productId,toId,line.quantity)}

  for(const {productId,warehouseId,delta} of deltas.values()){
    if(!delta)continue;
    const product=products.get(productId)!,current=Number(((product.stocks??{}) as Record<string,number>)[warehouseId]??0);
    if(current+delta<0)throw new LifecycleCommandError("لا يمكن تعديل التحويل لأن جزءًا من المخزون المطلوب عكسه تم التصرف فيه.",409);
  }
  for(const {productId,warehouseId,delta} of deltas.values()){
    if(!delta)continue;
    const warehouse=warehouseMap.get(warehouseId);
    if(!warehouse)throw new LifecycleCommandError("تعذر تحديد مخزن مرتبط بالتعديل",409);
    await changeStock(db,session,products.get(productId)!,warehouse,delta,audit,"transfer-edit");
  }

  const lines: Stored[] = input.map(line=>({ id: (oldLines.find(old => String(old.productId) === line.productId)?.id as string | undefined) ?? id("line"), productId: line.productId, description: products.get(line.productId)!.name, quantity: line.quantity, unitPrice: 0, lineTotal: 0 }));
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { warehouseId: fromId, warehouseName: from.name, destinationWarehouseId: toId, destinationWarehouseName: to.name, lines, updatedAt: new Date(), revision } }, { session });
  await preserveHistoricalWarehouseArchiveIfEmpty(db,session,String(oldFrom._id),oldFromWasArchived,oldFromArchivedAt);
  await preserveHistoricalWarehouseArchiveIfEmpty(db,session,String(oldTo._id),oldToWasArchived,oldToArchivedAt);
  return documentId;
}

async function voidTransfer(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "transfer", status: "posted" }, { session });
  if (!original) throw new LifecycleCommandError("تحويل المخزون غير موجود أو ملغى", 404);
  const [from, to] = await Promise.all([
    db.collection("warehouses").findOne({ _id: String(original.warehouseId) }, { session }),
    db.collection("warehouses").findOne({ _id: String(original.destinationWarehouseId) }, { session }),
  ]);
  if (!from || !to) throw new LifecycleCommandError("تعذر تحديد مخازن التحويل الأصلية", 409);
  const lines = (original.lines ?? []) as Stored[], products = await loadProducts(db, session, lines.map(line => String(line.productId))), revision = Number(original.revision ?? 0) + 1, audit = stockAuditDocument(original, revision);
  for (const line of lines) {
    const product = products.get(String(line.productId))!, quantity = Number(line.quantity ?? 0);
    await changeStock(db, session, product, from, quantity, audit, "transfer-void");
    try { await changeStock(db, session, product, to, -quantity, audit, "transfer-void"); }
    catch (error) { if (error instanceof LifecycleCommandError && /المخزون غير كاف/.test(error.message)) throw new LifecycleCommandError("لا يمكن إلغاء التحويل لأن جزءًا من المخزون المحول تم التصرف فيه.", 409); throw error; }
  }
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date(), revision } }, { session });
  return documentId;
}

const parseAdjustmentLines = (body: Input) => {
  if (!Array.isArray(body.lines) || !body.lines.length) throw new LifecycleCommandError("أضف منتجًا");
  const seen = new Set<string>();
  return body.lines.map(raw => {
    const record = raw as Input, productId = text(record.productId), actualQuantity = positive(record.actualQuantity, "الرصيد الفعلي", true);
    if (!productId || seen.has(productId)) throw new LifecycleCommandError("المنتجات غير صالحة أو مكررة");
    seen.add(productId); return { productId, actualQuantity };
  });
};

async function updateAdjustment(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), reason = text(body.reason), original = await db.collection("documents").findOne({ id: documentId, kind: "adjustment", status: "posted" }, { session });
  if (!original) throw new LifecycleCommandError("تصحيح المخزون غير موجود أو ملغى", 404);
  if (openingAdjustment(original)) throw new LifecycleCommandError("رصيد البداية يُصحح من شاشة رصيد البداية ولا يُعدّل كسند مخزون عادي", 409);
  if (!reason) throw new LifecycleCommandError("سبب التصحيح مطلوب");
  const input = parseAdjustmentLines(body), oldLines = (original.lines ?? []) as Stored[], oldIds = oldLines.map(line => String(line.productId));
  if (input.length !== oldIds.length || input.some(line => !oldIds.includes(line.productId))) throw new LifecycleCommandError("لا يمكن تغيير منتجات سند التصحيح بعد اعتماده؛ عدّل الكميات فقط أو ألغ السند وأنشئ سندًا جديدًا", 409);
  const warehouse = await db.collection("warehouses").findOne({ _id: String(original.warehouseId) }, { session });
  if (!warehouse) throw new LifecycleCommandError("مخزن التصحيح غير موجود", 409);
  const warehouseWasArchived=warehouse.isArchived===true,warehouseArchivedAt=warehouse.archivedAt;
  const products = await loadProducts(db, session, oldIds), revision = Number(original.revision ?? 0) + 1, audit = stockAuditDocument(original, revision);
  const revisedLines: Stored[] = [];
  for (const line of input) {
    const old = oldLines.find(item => String(item.productId) === line.productId)!;
    const baseline = Number(old.balanceBefore), oldDelta=Number(old.quantity??0);
    if (!Number.isFinite(baseline)||!Number.isFinite(oldDelta)) throw new LifecycleCommandError("سند التصحيح القديم لا يحتوي بيانات كافية للتعديل الآمن", 409);
    const revisedDelta = line.actualQuantity - baseline, editDelta = revisedDelta - oldDelta, product = products.get(line.productId)!;
    if(editDelta){
      try { await changeStock(db, session, product, warehouse, editDelta, audit, "adjustment-edit"); }
      catch (error) { if (error instanceof LifecycleCommandError && /المخزون غير كاف/.test(error.message)) throw new LifecycleCommandError("لا يمكن تعديل التصحيح لأن المخزون الحالي لا يكفي لهذا التغيير.", 409); throw error; }
    }
    revisedLines.push({ ...old, description: `${product.name} — ${reason} (قبل ${baseline}، بعد ${line.actualQuantity})`, quantity: revisedDelta, balanceBefore: baseline, balanceAfter: line.actualQuantity });
  }
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { title: reason, lines: revisedLines, updatedAt: new Date(), revision } }, { session });
  await preserveHistoricalWarehouseArchiveIfEmpty(db,session,String(warehouse._id),warehouseWasArchived,warehouseArchivedAt);
  return documentId;
}

async function voidAdjustment(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "adjustment", status: "posted" }, { session });
  if (!original) throw new LifecycleCommandError("تصحيح المخزون غير موجود أو ملغى", 404);
  if (openingAdjustment(original)) throw new LifecycleCommandError("لا يمكن إلغاء سجل رصيد البداية؛ استخدم تصحيح رصيد بداية جديدًا", 409);
  const warehouse = await db.collection("warehouses").findOne({ _id: String(original.warehouseId) }, { session });
  if (!warehouse) throw new LifecycleCommandError("مخزن التصحيح غير موجود", 409);
  const lines = (original.lines ?? []) as Stored[], products = await loadProducts(db, session, lines.map(line => String(line.productId))), revision = Number(original.revision ?? 0) + 1, audit = stockAuditDocument(original, revision);
  for (const line of lines) {
    try { await changeStock(db, session, products.get(String(line.productId))!, warehouse, -Number(line.quantity ?? 0), audit, "adjustment-void"); }
    catch (error) { if (error instanceof LifecycleCommandError && /المخزون غير كاف/.test(error.message)) throw new LifecycleCommandError("لا يمكن إلغاء التصحيح لأن مخزونًا ناتجًا عنه تم التصرف فيه.", 409); throw error; }
  }
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date(), revision } }, { session });
  return documentId;
}

async function partyCashPost(db: Db, session: ClientSession, body: Input) {
  const partyId = text(body.partyId), party = await db.collection("parties").findOne({ id: partyId, isArchived: { $ne: true } }, { session });
  if (!party) throw new LifecycleCommandError("الطرف غير موجود", 404);
  const amount = positive(body.amount, "المبلغ"), direction = text(body.direction);
  if (direction !== "receive" && direction !== "pay") throw new LifecycleCommandError("اتجاه الحركة غير صالح");
  const method = text(body.paymentMethod); await paymentAccount(db, session, method);
  const snapshot = await applyPartyNetDelta(db, session, partyId, partyCashDelta(direction, amount));
  const doc = { ...baseDocument("payment", "PAY"), partyId, partyName: party.name, warehouseId: null, warehouseName: null, destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod: method, title: direction === "receive" ? "استلام من الطرف" : "دفع للطرف", note: text(body.note) || null, total: amount, dueTotal: 0, paidTotal: amount, cashAmount: amount, partyCashDirection: direction, partyBalanceBefore: snapshot!.before, partyBalanceDelta: snapshot!.delta, partyBalanceAfter: snapshot!.after, lines: [] };
  await db.collection("documents").insertOne(doc, { session });
  await postFinancialMovement(db, session, doc, direction === "receive" ? "in" : "out", amount, direction === "receive" ? "party-receipt" : "party-payment");
  return doc.id;
}

async function partyCashUpdate(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "payment", status: "posted" }, { session });
  if (!original || (original.partyCashDirection !== "receive" && original.partyCashDirection !== "pay")) throw new LifecycleCommandError("الحركة المالية للطرف غير موجودة أو غير قابلة للتعديل", 404);
  const party = await db.collection("parties").findOne({ id: String(original.partyId) }, { session });
  if (!party) throw new LifecycleCommandError("الطرف غير موجود", 409);
  const wasArchived=party.isArchived===true,archivedAt=party.archivedAt;
  const amount = positive(body.amount, "المبلغ"), direction = text(body.direction), method = text(body.paymentMethod);
  if (direction !== "receive" && direction !== "pay") throw new LifecycleCommandError("اتجاه الحركة غير صالح");
  const historicalPayment = await paymentAccountForHistoricalEdit(db, session, method, original.paymentMethod);
  const oldAmount = Number(original.cashAmount ?? original.total ?? 0), oldDelta = Number.isFinite(Number(original.partyBalanceDelta)) ? Number(original.partyBalanceDelta) : partyCashDelta(String(original.partyCashDirection), oldAmount);
  await applyPartyNetDelta(db, session, original.partyId, -oldDelta, true);
  const movement = await findActiveFinancialMovement(db, session, { documentId, type: { $in: ["party-receipt", "party-payment"] } });
  if (!movement) throw new LifecycleCommandError("تعذر العثور على حركة الحساب المالي الأصلية", 409);
  await reverseFinancialMovement(db, session, movement, "تعديل حركة طرف");
  await reactivateHistoricalPaymentAccount(db, session, historicalPayment.account, historicalPayment.sameOriginal);
  const snapshot = await applyPartyNetDelta(db, session, original.partyId, partyCashDelta(direction, amount));
  const revision = Number(original.revision ?? 0) + 1;
  const revised = { paymentMethod: method, title: direction === "receive" ? "استلام من الطرف" : "دفع للطرف", note: text(body.note) || null, total: amount, paidTotal: amount, cashAmount: amount, partyCashDirection: direction, partyBalanceBefore: snapshot!.before, partyBalanceDelta: snapshot!.delta, partyBalanceAfter: snapshot!.after, updatedAt: new Date(), revision };
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: revised }, { session });
  await postFinancialMovement(db, session, { ...original, ...revised }, direction === "receive" ? "in" : "out", amount, direction === "receive" ? "party-receipt" : "party-payment");
  await preserveHistoricalPartyArchiveIfBalanced(db,session,String(original.partyId),wasArchived,archivedAt);
  return documentId;
}

async function partyCashVoid(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "payment", status: "posted" }, { session });
  if (!original || (original.partyCashDirection !== "receive" && original.partyCashDirection !== "pay")) throw new LifecycleCommandError("الحركة المالية للطرف غير موجودة أو ملغاة", 404);
  const amount = Number(original.cashAmount ?? original.total ?? 0), delta = Number.isFinite(Number(original.partyBalanceDelta)) ? Number(original.partyBalanceDelta) : partyCashDelta(String(original.partyCashDirection), amount);
  await applyPartyNetDelta(db, session, original.partyId, -delta, true);
  const movement = await findActiveFinancialMovement(db, session, { documentId, type: { $in: ["party-receipt", "party-payment"] } });
  if (!movement) throw new LifecycleCommandError("تعذر العثور على حركة الحساب المالي الأصلية", 409);
  await reverseFinancialMovement(db, session, movement, "إلغاء حركة طرف");
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date(), revision: Number(original.revision ?? 0) + 1 } }, { session });
  return documentId;
}


function finiteLegacyNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function legacyPartyBalanceDelta(document: Stored, activeMovement: Stored | null = null) {
  if (document.kind === "offset") return 0;
  const explicit = finiteLegacyNumber(document.partyBalanceDelta);
  if (explicit !== null) return explicit;
  const before = finiteLegacyNumber(document.partyBalanceBefore), after = finiteLegacyNumber(document.partyBalanceAfter);
  if (before !== null && after !== null) return after - before;
  const settledReceivable = finiteLegacyNumber(document.settledReceivable), settledPayable = finiteLegacyNumber(document.settledPayable);
  if ((settledReceivable ?? 0) !== 0 || (settledPayable ?? 0) !== 0) return -(settledReceivable ?? 0) + (settledPayable ?? 0);
  const amount = finiteLegacyNumber(document.cashAmount ?? document.paidTotal ?? document.total) ?? 0;
  if (activeMovement) return activeMovement.direction === "out" ? amount : -amount;
  const title = text(document.title);
  if (/استلام|دفع لنا|الطرف دفع لنا/.test(title)) return -amount;
  if (/دفع للطرف|دفع لل|نحن دفعنا|صرف/.test(title)) return amount;
  throw new LifecycleCommandError("تعذر تحديد أثر الحركة القديمة على رصيد الطرف بأمان", 409);
}

async function legacyPartyDocumentVoid(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId);
  const original = await db.collection("documents").findOne({ id: documentId, status: "posted" }, { session });
  if (!original || !["payment", "settlement", "offset"].includes(String(original.kind ?? ""))) throw new LifecycleCommandError("الحركة القديمة غير موجودة أو ملغاة بالفعل", 404);
  if (original.legacyKey) throw new LifecycleCommandError("السجلات المرحلة من نظام خارجي متاحة للعرض فقط", 409);
  if (original.kind === "payment" && (original.partyCashDirection === "receive" || original.partyCashDirection === "pay")) throw new LifecycleCommandError("استخدم حذف الحركة المالية الحالية لهذا المستند", 409);

  const movement = original.kind === "payment"
    ? await findActiveFinancialMovement(db, session, { documentId, type: { $in: ["party-receipt", "party-payment"] } })
    : null;
  const delta = legacyPartyBalanceDelta(original, movement);
  const partyId = text(original.partyId);
  const party = partyId ? await db.collection("parties").findOne({ id: partyId }, { session }) : null;
  if (party && delta) await applyPartyNetDelta(db, session, partyId, -delta, true);

  if (movement) await reverseFinancialMovement(db, session, movement, "إلغاء حركة طرف قديمة");
  const now = new Date();
  const changed = await db.collection("documents").updateOne(
    { id: documentId, status: "posted" },
    { $set: { status: "voided", voidedAt: now, updatedAt: now, revision: Number(original.revision ?? 0) + 1, legacyVoid: true } },
    { session },
  );
  if (!changed.matchedCount) throw new LifecycleCommandError("تم تغيير الحركة القديمة أثناء العملية، أعد المحاولة", 409);
  return documentId;
}

async function accountAdjustmentPost(db: Db, session: ClientSession, body: Input) {
  const account = await paymentAccount(db, session, body.accountId), direction = text(body.direction), amount = positive(body.amount, "المبلغ");
  if (direction !== "deposit" && direction !== "withdrawal") throw new LifecycleCommandError("نوع العملية غير صالح");
  const doc = { ...baseDocument("account-adjustment", direction === "deposit" ? "DEP" : "WDR"), paymentMethod: account.id, partyId: null, partyName: null, note: text(body.note) || null, total: amount, dueTotal: 0, paidTotal: amount, cashAmount: amount, accountAdjustmentDirection: direction, lines: [] };
  await postFinancialMovement(db, session, doc, direction === "deposit" ? "in" : "out", amount, direction === "deposit" ? "manual-deposit" : "manual-withdrawal");
  await db.collection("documents").insertOne(doc, { session });
  return doc.id;
}

async function accountAdjustmentUpdate(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), movement = await findActiveFinancialMovement(db, session, { documentId, type: { $in: ["manual-deposit", "manual-withdrawal"] } });
  if (!movement) throw new LifecycleCommandError("عملية السحب أو الإيداع غير موجودة أو ملغاة", 404);
  const storedDocument = await db.collection("documents").findOne({ id: documentId, kind: "account-adjustment", status: "posted" }, { session });
  const direction = text(body.direction), amount = positive(body.amount, "المبلغ"),requestedAccount=text(body.accountId),sameAccount=requestedAccount===String(movement.paymentMethod)||requestedAccount===String(movement.paymentCode??"");
  const account = await paymentAccount(db, session, requestedAccount, !sameAccount);
  if (direction !== "deposit" && direction !== "withdrawal") throw new LifecycleCommandError("نوع العملية غير صالح");
  await reverseFinancialMovement(db, session, movement, "تعديل سحب أو إيداع");
  if(sameAccount&&(account.isArchived===true||account.isActive===false))await db.collection("paymentAccounts").updateOne({id:account.id},{$set:{isArchived:false,isActive:true,archivedAt:null,updatedAt:new Date()}},{session});
  const revision = Number(storedDocument?.revision ?? movement.revision ?? 0) + 1, base = storedDocument ?? { id: documentId, number: movement.documentNumber, occurredAt: movement.occurredAt, kind: "account-adjustment", status: "posted", revision: 0, partyId: null, partyName: null, lines: [] };
  const revised = { paymentMethod: account.id, note: text(body.note) || null, total: amount, paidTotal: amount, cashAmount: amount, accountAdjustmentDirection: direction, updatedAt: new Date(), revision };
  await postFinancialMovement(db, session, { ...base, ...revised }, direction === "deposit" ? "in" : "out", amount, direction === "deposit" ? "manual-deposit" : "manual-withdrawal");
  if (storedDocument) await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: revised }, { session });
  else await db.collection("documents").insertOne({ ...base, ...revised }, { session });
  return documentId;
}

async function accountAdjustmentVoid(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), movement = await findActiveFinancialMovement(db, session, { documentId, type: { $in: ["manual-deposit", "manual-withdrawal"] } });
  if (!movement) throw new LifecycleCommandError("عملية السحب أو الإيداع غير موجودة أو ملغاة", 404);
  await reverseFinancialMovement(db, session, movement, "إلغاء سحب أو إيداع");
  const storedDocument = await db.collection("documents").findOne({ id: documentId, kind: "account-adjustment" }, { session });
  if (storedDocument) await db.collection("documents").updateOne({ id: documentId }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date(), revision: Number(storedDocument.revision ?? 0) + 1 } }, { session });
  else await db.collection("documents").insertOne({ id: documentId, number: movement.documentNumber, kind: "account-adjustment", status: "voided", occurredAt: movement.occurredAt, voidedAt: new Date(), revision: Number(movement.revision ?? 0) + 1, paymentMethod: movement.paymentMethod, total: movement.amount, lines: [] }, { session });
  return documentId;
}

async function accountTransferPost(db: Db, session: ClientSession, body: Input) {
  const from = await paymentAccount(db, session, body.fromAccountId), to = await paymentAccount(db, session, body.toAccountId), amount = positive(body.amount, "المبلغ");
  if (from.id === to.id) throw new LifecycleCommandError("اختر حسابين مختلفين");
  const transferId = id("transfer"), base = baseDocument("account-transfer", "BTR"), doc = { ...base, id: transferId, transferId, paymentMethod: from.id, fromAccountId: from.id, toAccountId: to.id, note: text(body.note) || null, partyId: null, partyName: null, total: amount, dueTotal: 0, paidTotal: amount, cashAmount: amount, lines: [] };
  await postFinancialMovement(db, session, doc, "out", amount, "transfer-out");
  await postFinancialMovement(db, session, { ...doc, paymentMethod: to.id }, "in", amount, "transfer-in");
  await db.collection("documents").insertOne(doc, { session });
  await db.collection("accountTransfers").insertOne({ id: transferId, documentId: transferId, number: doc.number, fromAccountId: from.id, toAccountId: to.id, amount, note: doc.note, occurredAt: doc.occurredAt, status: "posted", revision: 0 }, { session });
  return transferId;
}

async function accountTransferUpdate(db: Db, session: ClientSession, body: Input) {
  const transferId = text(body.transferId ?? body.documentId), transfer = await db.collection("accountTransfers").findOne({ id: transferId, status: { $ne: "voided" } }, { session });
  if (!transfer) throw new LifecycleCommandError("التحويل البنكي غير موجود أو ملغى", 404);
  const active = await db.collection("financialMovements").find({ transferId, status: { $ne: "reversed" }, isReversal: { $ne: true } }, { session }).toArray();
  const transferMovements = active.filter(movement => movement.type === "transfer-out" || movement.type === "transfer-in");
  if (transferMovements.length !== 2) throw new LifecycleCommandError("سجل التحويل البنكي غير مكتمل ولا يمكن تعديله بأمان", 409);
  const requestedFrom=text(body.fromAccountId),requestedTo=text(body.toAccountId),sameFrom=requestedFrom===String(transfer.fromAccountId),sameTo=requestedTo===String(transfer.toAccountId);
  const [from,to]=await Promise.all([paymentAccount(db,session,requestedFrom,!sameFrom),paymentAccount(db,session,requestedTo,!sameTo)]),amount=positive(body.amount,"المبلغ");
  for (const movement of transferMovements) await reverseFinancialMovement(db, session, movement, "تعديل تحويل بنكي");
  for(const account of [from,to])if(account.isArchived===true||account.isActive===false)await db.collection("paymentAccounts").updateOne({id:account.id},{$set:{isArchived:false,isActive:true,archivedAt:null,updatedAt:new Date()}},{session});
  if (from.id === to.id) throw new LifecycleCommandError("اختر حسابين مختلفين");
  const storedDocument = await db.collection("documents").findOne({ id: String(transfer.documentId ?? transferId), kind: "account-transfer" }, { session });
  const revision = Number(transfer.revision ?? storedDocument?.revision ?? 0) + 1, doc = storedDocument ?? { id: transferId, number: transfer.number, kind: "account-transfer", status: "posted", occurredAt: transfer.occurredAt, partyId: null, partyName: null, lines: [] };
  const revised = { transferId, paymentMethod: from.id, fromAccountId: from.id, toAccountId: to.id, note: text(body.note) || null, total: amount, paidTotal: amount, cashAmount: amount, updatedAt: new Date(), revision, status: "posted" };
  await postFinancialMovement(db, session, { ...doc, ...revised }, "out", amount, "transfer-out");
  await postFinancialMovement(db, session, { ...doc, ...revised, paymentMethod: to.id }, "in", amount, "transfer-in");
  await db.collection("accountTransfers").updateOne({ id: transferId }, { $set: { fromAccountId: from.id, toAccountId: to.id, amount, note: revised.note, status: "posted", revision, updatedAt: new Date(), documentId: doc.id } }, { session });
  if (storedDocument) await db.collection("documents").updateOne({ id: doc.id }, { $set: revised }, { session });
  else await db.collection("documents").insertOne({ ...doc, ...revised }, { session });
  return transferId;
}

async function accountTransferVoid(db: Db, session: ClientSession, body: Input) {
  const transferId = text(body.transferId ?? body.documentId), transfer = await db.collection("accountTransfers").findOne({ id: transferId, status: { $ne: "voided" } }, { session });
  if (!transfer) throw new LifecycleCommandError("التحويل البنكي غير موجود أو ملغى", 404);
  const active = await db.collection("financialMovements").find({ transferId, status: { $ne: "reversed" }, isReversal: { $ne: true } }, { session }).toArray();
  const transferMovements = active.filter(movement => movement.type === "transfer-out" || movement.type === "transfer-in");
  if (transferMovements.length !== 2) throw new LifecycleCommandError("سجل التحويل البنكي غير مكتمل ولا يمكن إلغاؤه بأمان", 409);
  for (const movement of transferMovements) await reverseFinancialMovement(db, session, movement, "إلغاء تحويل بنكي");
  const revision = Number(transfer.revision ?? 0) + 1, now = new Date();
  await db.collection("accountTransfers").updateOne({ id: transferId }, { $set: { status: "voided", voidedAt: now, updatedAt: now, revision } }, { session });
  const documentId = String(transfer.documentId ?? transferId), document = await db.collection("documents").findOne({ id: documentId, kind: "account-transfer" }, { session });
  if (document) await db.collection("documents").updateOne({ id: documentId }, { $set: { status: "voided", voidedAt: now, updatedAt: now, revision } }, { session });
  return transferId;
}

export async function executeLifecycleCommand(db: Db, session: ClientSession, body: Input): Promise<{ handled: boolean; result?: unknown }> {
  switch (text(body.type)) {
    case "party-cash.post": return { handled: true, result: await partyCashPost(db, session, body) };
    case "party-cash.update": return { handled: true, result: await partyCashUpdate(db, session, body) };
    case "party-cash.void": return { handled: true, result: await partyCashVoid(db, session, body) };
    case "legacy-party-document.void": return { handled: true, result: await legacyPartyDocumentVoid(db, session, body) };
    case "transfer.update": return { handled: true, result: await updateTransfer(db, session, body) };
    case "transfer.void": return { handled: true, result: await voidTransfer(db, session, body) };
    case "adjustment.update": return { handled: true, result: await updateAdjustment(db, session, body) };
    case "adjustment.void": return { handled: true, result: await voidAdjustment(db, session, body) };
    case "account-adjustment.post": return { handled: true, result: await accountAdjustmentPost(db, session, body) };
    case "account-adjustment.update": return { handled: true, result: await accountAdjustmentUpdate(db, session, body) };
    case "account-adjustment.void": return { handled: true, result: await accountAdjustmentVoid(db, session, body) };
    case "account-transfer.post": return { handled: true, result: await accountTransferPost(db, session, body) };
    case "account-transfer.update": return { handled: true, result: await accountTransferUpdate(db, session, body) };
    case "account-transfer.void": return { handled: true, result: await accountTransferVoid(db, session, body) };
    default: return { handled: false };
  }
}
