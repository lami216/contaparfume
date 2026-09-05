import type { SqliteDatabase as Db, SqliteSession as ClientSession } from "../lib/sqlite.ts";
import { nextDocumentSequence } from "../lib/document-sequences.ts";
import { normalizePartyNet, partyNet } from "./party-balance.ts";
import type { PerfumeAllocation, PerfumeLot } from "./perfume-logic.ts";

type Input = Record<string, unknown>;
type ProductDoc = Record<string, unknown>;
type WarehouseDoc = { _id: string; name: string; isArchived?: boolean; [key: string]: unknown };
type InvoiceLine = {
  id: string;
  productId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  costAtSale?: number | null;
  grossProfit?: number | null;
  perfumeAllocations?: PerfumeAllocation[];
  bottleProductId?: string | null;
  bottleProductName?: string | null;
  bottleUnitCost?: number | null;
  bottleQuantity?: number | null;
};

export class PerfumeInvoiceCommandError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const num = (value: unknown) => typeof value === "number" ? value : Number(value);
const positive = (value: unknown, label: string, allowZero = false) => {
  const parsed = num(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new PerfumeInvoiceCommandError(`${label} غير صالح`);
  return parsed;
};
const warehouses = (db: Db) => db.collection<WarehouseDoc>("warehouses");

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
  if (!counter) throw new PerfumeInvoiceCommandError("تعذر توليد رمز المنتج", 409);
  return String(counter.value);
}

function baseDocument(kind: string, prefix: string) {
  return { id: id(kind), number: `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, kind, status: "posted", occurredAt: new Date().toISOString() };
}
async function numberedDocument(db: Db, session: ClientSession, kind: "decant-sale" | "decant-purchase", prefix: string) {
  return { ...baseDocument(kind, prefix), sequence: await nextDocumentSequence(db, kind, session) };
}

async function paymentAccount(db: Db, session: ClientSession, value: unknown, active = true) {
  const key = text(value);
  const account = await db.collection("paymentAccounts").findOne({ $or: [{ id: key }, { code: key }], ...(active ? { isActive: true, isArchived: { $ne: true } } : {}) }, { session });
  if (!account) throw new PerfumeInvoiceCommandError("يجب اختيار وسيلة دفع صالحة");
  return account;
}

async function financialMovement(db: Db, session: ClientSession, document: Record<string, unknown>, direction: "in" | "out", amount: number, type: string) {
  if (!amount) return;
  const account = await paymentAccount(db, session, document.paymentMethod);
  const delta = direction === "in" ? amount : -amount;
  const result = await db.collection("paymentAccounts").updateOne({ id: account.id }, { $inc: { balance: delta } }, { session });
  if (!result.matchedCount) throw new PerfumeInvoiceCommandError(`الرصيد غير كافٍ في ${account.name}`);
  await db.collection("financialMovements").insertOne({
    id: id("fin"), paymentMethod: account.id, paymentCode: account.code, direction, amount,
    documentId: document.id, documentNumber: document.number, partyId: document.partyId ?? null,
    partyName: document.partyName ?? null, type, occurredAt: document.occurredAt,
  }, { session });
}

async function reverseFinancialMovement(db: Db, session: ClientSession, document: Record<string, unknown>, kind: "decant-sale" | "decant-purchase") {
  const amount = Number(document.cashAmount ?? document.paidTotal ?? 0);
  if (!amount) return;
  const movement = await db.collection("financialMovements").findOne({ documentId: document.id, type: kind }, { session });
  if (!movement) throw new PerfumeInvoiceCommandError("تعذر العثور على حركة الدفع الأصلية للفاتورة", 409);
  const account = await paymentAccount(db, session, movement.paymentMethod, false);
  await db.collection("paymentAccounts").updateOne({ id: account.id }, { $inc: { balance: kind === "decant-sale" ? -amount : amount } }, { session });
  await db.collection("financialMovements").deleteOne({ _id: movement._id }, { session });
}

async function applyPartyNetDelta(db: Db, session: ClientSession, partyId: unknown, delta: number) {
  if (!delta || !partyId) return null;
  const party = await db.collection("parties").findOne({ id: String(partyId) }, { session });
  if (!party) throw new PerfumeInvoiceCommandError("الطرف غير موجود", 404);
  const before = partyNet(party as { receivable?: unknown; payable?: unknown });
  const after = before + delta;
  await db.collection("parties").updateOne({ _id: party._id }, { $set: { ...normalizePartyNet(after), lastMovementAt: new Date() } }, { session });
  return { before, delta, after };
}

async function authoritativeCost(db: Db, session: ClientSession, product: ProductDoc) {
  if (product.perfumeForm === "partial" && Number.isFinite(Number(product.pieceCost))) return Number(product.pieceCost);
  if (Number.isFinite(Number(product.lastPurchaseCost))) return Number(product.lastPurchaseCost);
  const latest = await db.collection("documents").findOne(
    { kind: { $in: ["purchase", "decant-purchase"] }, status: "posted", "lines.productId": product.id },
    { session, sort: { occurredAt: -1 }, projection: { lines: 1, occurredAt: 1 } },
  );
  const line = (latest?.lines as Array<Record<string, unknown>> | undefined)?.find(item => item.productId === product.id);
  if (!line || !Number.isFinite(Number(line.unitPrice))) return null;
  const cost = Number(line.unitPrice);
  await db.collection("products").updateOne({ id: product.id }, { $set: { lastPurchaseCost: cost, lastPurchaseAt: latest?.occurredAt } }, { session });
  product.lastPurchaseCost = cost;
  return cost;
}

async function recomputeBottleCost(db: Db, session: ClientSession, productId: string) {
  const latest = await db.collection("documents").findOne(
    { kind: "decant-purchase", status: "posted", "lines.productId": productId },
    { session, sort: { occurredAt: -1 } },
  );
  const line = (latest?.lines as Array<Record<string, unknown>> | undefined)?.find(item => item.productId === productId);
  await db.collection("products").updateOne({ id: productId }, { $set: { lastPurchaseCost: line ? Number(line.unitPrice) : null, lastPurchaseAt: latest?.occurredAt ?? null } }, { session });
}

async function changeStock(db: Db, session: ClientSession, product: ProductDoc, warehouse: WarehouseDoc, delta: number, document: Record<string, unknown>, type: string) {
  const warehouseId = String(warehouse._id), productId = String(product.id);
  const before = Number((product.stocks as Record<string, number> | undefined)?.[warehouseId] ?? 0), after = before + delta;
  if (after < 0) throw new PerfumeInvoiceCommandError(`المخزون غير كافٍ للمنتج ${product.name}`);
  const stockPath = `stocks.${warehouseId}`;
  const stockMatch = before === 0 ? { $or: [{ [stockPath]: 0 }, { [stockPath]: { $exists: false } }] } : { [stockPath]: before };
  const result = await db.collection("products").updateOne({ id: productId, ...stockMatch }, { $set: { [stockPath]: after } }, { session });
  if (!result.matchedCount) throw new PerfumeInvoiceCommandError("تغير المخزون أثناء العملية، أعد المحاولة", 409);
  const stocks = (product.stocks ??= {}) as Record<string, number>; stocks[warehouseId] = after;
  await db.collection("stockMovements").insertOne({
    id: id("mov"), documentId: document.id, documentNumber: document.number,
    warehouseId, warehouseName: warehouse.name, productId, productName: product.name,
    type, quantityDelta: delta, balanceBefore: before, balanceAfter: after, occurredAt: document.occurredAt,
  }, { session });
}

function perfumeLots(product: ProductDoc) {
  return structuredClone(Array.isArray(product.perfumeLots) ? product.perfumeLots : []) as PerfumeLot[];
}
async function savePerfumeLots(db: Db, session: ClientSession, product: ProductDoc, lots: PerfumeLot[]) {
  await db.collection("products").updateOne({ id: product.id }, { $set: { perfumeLots: lots } }, { session });
  product.perfumeLots = lots;
}
async function consumeLiquidLots(db: Db, session: ClientSession, product: ProductDoc, warehouseId: string, quantity: number) {
  if (product.perfumeForm !== "decant") throw new PerfumeInvoiceCommandError("هذا المنتج ليس تقسيمة", 409);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new PerfumeInvoiceCommandError("كمية التقسيمات يجب أن تكون عددًا صحيحًا");
  const lots = perfumeLots(product).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  let remaining = quantity, totalCost = 0;
  const allocations: PerfumeAllocation[] = [];
  for (const lot of lots) {
    const available = Number(lot.stocks?.[warehouseId] ?? 0);
    if (available <= 0 || remaining <= 0) continue;
    const take = Math.min(available, remaining);
    lot.stocks = { ...(lot.stocks ?? {}), [warehouseId]: available - take };
    lot.remainingQuantity = Math.max(0, Number(lot.remainingQuantity ?? 0) - take);
    const liquidUnitCost = Number(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0);
    totalCost += take * liquidUnitCost;
    allocations.push({ lotId: lot.id, quantity: take, unitCost: liquidUnitCost, warehouseId });
    remaining -= take;
  }
  if (remaining > 0) throw new PerfumeInvoiceCommandError("مخزون دفعات التقسيمات غير كافٍ", 409);
  await savePerfumeLots(db, session, product, lots);
  return { allocations, totalCost };
}
async function restoreLiquidAllocations(db: Db, session: ClientSession, product: ProductDoc, allocations: PerfumeAllocation[] | undefined) {
  if (product.perfumeForm !== "decant" || !allocations?.length) return;
  const lots = perfumeLots(product), byId = new Map(lots.map(lot => [lot.id, lot]));
  for (const allocation of allocations) {
    const lot = byId.get(allocation.lotId);
    if (!lot) throw new PerfumeInvoiceCommandError("تعذر العثور على دفعة التقسيم الأصلية", 409);
    const amount = Number(allocation.quantity), warehouseId = String(allocation.warehouseId);
    lot.stocks = { ...(lot.stocks ?? {}), [warehouseId]: Number(lot.stocks?.[warehouseId] ?? 0) + amount };
    lot.remainingQuantity = Number(lot.remainingQuantity ?? 0) + amount;
  }
  await savePerfumeLots(db, session, product, lots);
}

function parseLines(body: Input) {
  if (!Array.isArray(body.lines) || !body.lines.length) throw new PerfumeInvoiceCommandError("يجب إضافة منتج واحد على الأقل");
  const seen = new Set<string>();
  return body.lines.map(raw => {
    const line = raw as Input, productId = text(line.productId), quantity = positive(line.quantity, "الكمية"), unitPrice = positive(line.unitPrice ?? line.piecePrice, "سعر الفرد");
    if (!Number.isInteger(quantity)) throw new PerfumeInvoiceCommandError("الكمية يجب أن تكون عددًا صحيحًا");
    if (!productId || seen.has(productId)) throw new PerfumeInvoiceCommandError("المنتجات غير صالحة أو مكررة");
    seen.add(productId);
    return { productId, quantity, unitPrice, bottleProductId: text(line.bottleProductId) || null };
  });
}

async function refs(db: Db, session: ClientSession, body: Input, partyType: "customer" | "supplier") {
  const warehouseId = text(body.warehouseId), partyId = text(body.partyId);
  const [warehouse, party] = await Promise.all([
    warehouseId ? warehouses(db).findOne({ _id: warehouseId, isArchived: { $ne: true } }, { session }) : null,
    partyId ? db.collection("parties").findOne({ id: partyId }, { session }) : null,
  ]);
  if (!warehouse) throw new PerfumeInvoiceCommandError("المخزن غير موجود", 404);
  if (party && party.partyType !== partyType) throw new PerfumeInvoiceCommandError(partyType === "customer" ? "يجب اختيار عميل صالح" : "يجب اختيار مورد صالح");
  return { warehouse, warehouseId, party, partyId };
}

async function createBottle(db: Db, session: ClientSession, body: Input) {
  const name = text(body.name), sizeMl = positive(body.sizeMl, "حجم الزجاجة"), cost = positive(body.cost, "تكلفة الزجاجة");
  if (!name) throw new PerfumeInvoiceCommandError("اسم زجاجة التقسيمة مطلوب");
  const duplicate = await db.collection("products").findOne({ perfumeForm: "bottle", name, decantSizeMl: sizeMl, isArchived: { $ne: true } }, { session });
  if (duplicate) throw new PerfumeInvoiceCommandError("زجاجة تقسيمة بنفس الاسم والحجم موجودة بالفعل", 409);
  const product = {
    id: id("product"), sku: await nextProductCode(db, session), name, barcode: "",
    pieceCost: cost, lastPurchaseCost: null, lastPurchaseAt: null, piecePrice: null, wholesalePrice: null,
    expiryDate: null, note: null, perfumeForm: "bottle", parentProductId: null, decantSizeMl: sizeMl,
    stocks: {}, createdAt: new Date(),
  };
  await db.collection("products").insertOne(product, { session });
  return String(product.id);
}

async function postSale(db: Db, session: ClientSession, body: Input) {
  const input = parseLines(body), paymentMethod = text(body.paymentMethod), { warehouse, warehouseId, party, partyId } = await refs(db, session, body, "customer");
  if (paymentMethod !== "note") await paymentAccount(db, session, paymentMethod);
  const ids = [...new Set(input.flatMap(line => [line.productId, line.bottleProductId].filter(Boolean) as string[]))];
  const found = await db.collection("products").find({ id: { $in: ids }, isArchived: { $ne: true } }, { session }).toArray();
  const products = new Map(found.map(product => [String(product.id), product]));
  if (products.size !== ids.length) throw new PerfumeInvoiceCommandError("أحد المنتجات غير موجود", 404);
  const doc = {
    ...await numberedDocument(db, session, "decant-sale", "DCS"), businessDate: new Date().toISOString().slice(0, 10),
    partyId: partyId || null, partyName: party?.name ?? "بيع تقسيمات مباشر", warehouseId, warehouseName: warehouse.name,
    destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod,
    title: "فاتورة التقسيمات", total: 0, dueTotal: 0, paidTotal: 0, cashAmount: 0, lines: [] as InvoiceLine[],
  };
  for (const line of input) {
    const product = products.get(line.productId)!;
    const form = String(product.perfumeForm ?? "");
    if (form !== "decant" && form !== "bottle") throw new PerfumeInvoiceCommandError("فاتورة التقسيمات تقبل التقسيمات وزجاج التقسيمات فقط", 409);
    const lineTotal = Math.round(line.quantity * line.unitPrice);
    if (form === "decant") {
      if (!line.bottleProductId) throw new PerfumeInvoiceCommandError(`اختر زجاجة التقسيمة للمنتج ${product.name}`);
      const bottle = products.get(line.bottleProductId);
      if (!bottle || bottle.perfumeForm !== "bottle") throw new PerfumeInvoiceCommandError("زجاجة التقسيمة غير صالحة", 409);
      const liquid = await consumeLiquidLots(db, session, product, warehouseId, line.quantity);
      const bottleCost = await authoritativeCost(db, session, bottle);
      if (bottleCost == null || bottleCost < 0) throw new PerfumeInvoiceCommandError(`لا توجد تكلفة شراء معتمدة للزجاجة ${bottle.name}`, 409);
      const totalCost = liquid.totalCost + line.quantity * bottleCost;
      doc.lines.push({
        id: id("line"), productId: line.productId, description: `${product.name} — ${bottle.name}`, quantity: line.quantity,
        unitPrice: line.unitPrice, lineTotal, costAtSale: totalCost / line.quantity, grossProfit: lineTotal - totalCost,
        perfumeAllocations: liquid.allocations, bottleProductId: String(bottle.id), bottleProductName: String(bottle.name),
        bottleUnitCost: bottleCost, bottleQuantity: line.quantity,
      });
      await changeStock(db, session, product, warehouse, -line.quantity, doc, "decant-sale-liquid");
      await changeStock(db, session, bottle, warehouse, -line.quantity, doc, "decant-sale-bottle");
    } else {
      if (line.bottleProductId) throw new PerfumeInvoiceCommandError("بيع الزجاجة الفارغة لا يحتاج اختيار زجاجة أخرى");
      const cost = await authoritativeCost(db, session, product);
      if (cost == null || cost < 0) throw new PerfumeInvoiceCommandError(`لا توجد تكلفة شراء معتمدة للزجاجة ${product.name}`, 409);
      doc.lines.push({ id: id("line"), productId: line.productId, description: String(product.name), quantity: line.quantity, unitPrice: line.unitPrice, lineTotal, costAtSale: cost, grossProfit: lineTotal - line.quantity * cost });
      await changeStock(db, session, product, warehouse, -line.quantity, doc, "decant-sale-empty-bottle");
    }
  }
  doc.total = doc.lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const cashAmount = paymentMethod === "note" ? 0 : positive(body.cashAmount ?? doc.total, "المبلغ المستلم", true);
  const paidTotal = Math.min(doc.total, cashAmount), dueTotal = Math.max(doc.total - cashAmount, 0), partyDelta = doc.total - cashAmount;
  if (partyDelta && !party) throw new PerfumeInvoiceCommandError("اختر عميلاً عند وجود مبلغ مستحق");
  const snapshot = partyDelta ? await applyPartyNetDelta(db, session, partyId, partyDelta) : null;
  Object.assign(doc, { cashAmount, paidTotal, dueTotal, ...(snapshot ? { partyBalanceBefore: snapshot.before, partyBalanceDelta: snapshot.delta, partyBalanceAfter: snapshot.after } : {}) });
  await db.collection("documents").insertOne(doc, { session });
  if (cashAmount) await financialMovement(db, session, doc, "in", cashAmount, "decant-sale");
  return String(doc.id);
}

async function postPurchase(db: Db, session: ClientSession, body: Input) {
  const input = parseLines(body), paymentMethod = text(body.paymentMethod), { warehouse, warehouseId, party, partyId } = await refs(db, session, body, "supplier");
  if (paymentMethod !== "note") await paymentAccount(db, session, paymentMethod);
  const found = await db.collection("products").find({ id: { $in: input.map(line => line.productId) }, perfumeForm: "bottle", isArchived: { $ne: true } }, { session }).toArray();
  const products = new Map(found.map(product => [String(product.id), product]));
  if (products.size !== input.length) throw new PerfumeInvoiceCommandError("فاتورة شراء زجاج التقسيمات تقبل زجاج التقسيمات فقط", 409);
  const doc = {
    ...await numberedDocument(db, session, "decant-purchase", "DCP"), partyId: partyId || null,
    partyName: party?.name ?? "شراء زجاج مباشر", warehouseId, warehouseName: warehouse.name,
    destinationWarehouseId: null, destinationWarehouseName: null, parentDocumentId: null, paymentMethod,
    title: "فاتورة شراء زجاج التقسيمات", total: 0, dueTotal: 0, paidTotal: 0, cashAmount: 0,
    lines: input.map(line => ({ id: id("line"), productId: line.productId, description: String(products.get(line.productId)!.name), quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: Math.round(line.quantity * line.unitPrice) })),
  };
  doc.total = doc.lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const cashAmount = paymentMethod === "note" ? 0 : positive(body.cashAmount ?? doc.total, "المبلغ المدفوع", true);
  const paidTotal = Math.min(doc.total, cashAmount), dueTotal = Math.max(doc.total - cashAmount, 0), partyDelta = -doc.total + cashAmount;
  if (partyDelta && !party) throw new PerfumeInvoiceCommandError("اختر موردًا عند وجود مبلغ مستحق");
  const snapshot = partyDelta ? await applyPartyNetDelta(db, session, partyId, partyDelta) : null;
  Object.assign(doc, { cashAmount, paidTotal, dueTotal, ...(snapshot ? { partyBalanceBefore: snapshot.before, partyBalanceDelta: snapshot.delta, partyBalanceAfter: snapshot.after } : {}) });
  for (const line of input) {
    const product = products.get(line.productId)!;
    await changeStock(db, session, product, warehouse, line.quantity, doc, "decant-purchase");
    await db.collection("products").updateOne({ id: line.productId }, { $set: { lastPurchaseCost: line.unitPrice, lastPurchaseAt: doc.occurredAt } }, { session });
    product.lastPurchaseCost = line.unitPrice;
  }
  await db.collection("documents").insertOne(doc, { session });
  if (cashAmount) await financialMovement(db, session, doc, "out", cashAmount, "decant-purchase");
  return String(doc.id);
}

async function voidSale(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "decant-sale", status: "posted" }, { session });
  if (!original) throw new PerfumeInvoiceCommandError("فاتورة التقسيمات غير موجودة أو ملغاة بالفعل", 404);
  const warehouse = await warehouses(db).findOne({ _id: String(original.warehouseId) }, { session });
  if (!warehouse) throw new PerfumeInvoiceCommandError("مخزن الفاتورة غير موجود", 409);
  const lines = (original.lines ?? []) as InvoiceLine[], ids = [...new Set(lines.flatMap(line => [line.productId, line.bottleProductId].filter(Boolean) as string[]))];
  const found = await db.collection("products").find({ id: { $in: ids } }, { session }).toArray(), products = new Map(found.map(product => [String(product.id), product]));
  if (products.size !== ids.length) throw new PerfumeInvoiceCommandError("أحد منتجات الفاتورة لم يعد موجودًا", 409);
  for (const line of lines) {
    const product = products.get(line.productId)!;
    if (product.perfumeForm === "decant") {
      await restoreLiquidAllocations(db, session, product, line.perfumeAllocations);
      await changeStock(db, session, product, warehouse, line.quantity, original, "decant-sale-void-liquid");
      if (line.bottleProductId) await changeStock(db, session, products.get(line.bottleProductId)!, warehouse, Number(line.bottleQuantity ?? line.quantity), original, "decant-sale-void-bottle");
    } else await changeStock(db, session, product, warehouse, line.quantity, original, "decant-sale-void-empty-bottle");
  }
  if (Number(original.partyBalanceDelta ?? 0)) await applyPartyNetDelta(db, session, original.partyId, -Number(original.partyBalanceDelta));
  await reverseFinancialMovement(db, session, original, "decant-sale");
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date() } }, { session });
  return documentId;
}

async function voidPurchase(db: Db, session: ClientSession, body: Input) {
  const documentId = text(body.documentId), original = await db.collection("documents").findOne({ id: documentId, kind: "decant-purchase", status: "posted" }, { session });
  if (!original) throw new PerfumeInvoiceCommandError("فاتورة شراء زجاج التقسيمات غير موجودة أو ملغاة بالفعل", 404);
  const warehouse = await warehouses(db).findOne({ _id: String(original.warehouseId) }, { session });
  if (!warehouse) throw new PerfumeInvoiceCommandError("مخزن الفاتورة غير موجود", 409);
  const lines = (original.lines ?? []) as InvoiceLine[], found = await db.collection("products").find({ id: { $in: lines.map(line => line.productId) } }, { session }).toArray(), products = new Map(found.map(product => [String(product.id), product]));
  if (products.size !== lines.length) throw new PerfumeInvoiceCommandError("أحد منتجات الفاتورة لم يعد موجودًا", 409);
  for (const line of lines) {
    try { await changeStock(db, session, products.get(line.productId)!, warehouse, -line.quantity, original, "decant-purchase-void"); }
    catch (error) { if (error instanceof PerfumeInvoiceCommandError && /المخزون غير كاف/.test(error.message)) throw new PerfumeInvoiceCommandError("لا يمكن حذف الفاتورة لأن جزءًا من مخزون الزجاج تم التصرف فيه.", 409); throw error; }
  }
  if (Number(original.partyBalanceDelta ?? 0)) await applyPartyNetDelta(db, session, original.partyId, -Number(original.partyBalanceDelta));
  await reverseFinancialMovement(db, session, original, "decant-purchase");
  await db.collection("documents").updateOne({ id: documentId, status: "posted" }, { $set: { status: "voided", voidedAt: new Date(), updatedAt: new Date() } }, { session });
  for (const line of lines) await recomputeBottleCost(db, session, line.productId);
  return documentId;
}

export async function handlePerfumeInvoiceCommand(db: Db, session: ClientSession, body: Input): Promise<string | null> {
  switch (text(body.type)) {
    case "perfume-bottle.create": return createBottle(db, session, body);
    case "decant-sale.post": return postSale(db, session, body);
    case "decant-sale.void": return voidSale(db, session, body);
    case "decant-purchase.post": return postPurchase(db, session, body);
    case "decant-purchase.void": return voidPurchase(db, session, body);
    default: return null;
  }
}
