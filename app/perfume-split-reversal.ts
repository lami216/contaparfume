import type { SqliteDatabase as Db, SqliteSession as Session, DbDocument as Row } from "../lib/sqlite.ts";
import type { PerfumeLot } from "./perfume-logic.ts";
import { documentUsesPerfumeLot } from "./perfume-management.ts";
import { roundMl } from "./perfume-volume.ts";
import { perfumeLotEquals } from "./perfume-stock-reconciliation.ts";
import { perfumeOperationBlocked } from "./perfume-operation-guards.ts";

const conflict = () => Object.assign(new Error("لا يمكن إلغاء التحويل لأن له حركات لاحقة غير ملغاة، أو اختلافًا غير موثق في رصيد الدفعة."), { status: 409 });
const values = (stocks: Record<string, number>) => Object.values(stocks).reduce((sum, value) => sum + Number(value), 0);
const equal = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8;

/** The shared accounting core restores visible stock, but knows no perfume allocations. */
export async function restoreLegacySaleAllocations(db: Db, session: Session, original: Row) {
  const products = new Map<string, Row>();
  for (const line of original.lines as Row[]) {
    if (!Array.isArray(line.perfumeAllocations) || !line.perfumeAllocations.length) continue;
    const productId = String(line.productId);
    let product = products.get(productId);
    if (!product) {
      product = await db.collection("products").findOne({ id: productId, perfumeForm: "decant" }, { session }) ?? undefined;
      if (!product) throw conflict();
      product.perfumeLots = structuredClone(product.perfumeLots ?? []);
      products.set(productId, product);
    }
    for (const allocation of line.perfumeAllocations as Row[]) {
      const lot = (product.perfumeLots as PerfumeLot[]).find(item => item.id === allocation.lotId);
      if (!lot || lot.settledAt) throw conflict();
      if (lot.recombinedAt) {
        const returned = lot.partialProductId && await db.collection("documents").findOne({ status: "posted", perfumeConversionType: "perfume-recombine", "lines.productId": lot.partialProductId }, { session });
        if (!returned || returned.perfumeLotAfter || lot.quantityUnit === "ml") throw conflict();
      }
      const scale = lot.quantityUnit === "ml" && allocation.quantityUnit !== "ml" ? Number(lot.legacyQuantityScaleMl ?? product.legacyDecantUnitMl) : 1;
      const amount = Number(allocation.quantity) * scale, wh = String(allocation.warehouseId);
      if (!Number.isFinite(amount) || amount <= 0 || !wh || wh !== original.warehouseId) throw conflict();
      // Restoring the historical quantity at a later yield-correction cost would
      // manufacture inventory value. A unit conversion changes both operands;
      // a genuine revaluation must be reversed before this older sale can be.
      const originalUnitCost = Number(allocation.unitCost) / scale, currentUnitCost = Number(lot.liquidUnitCost ?? lot.landedUnitCost);
      if (!equal(originalUnitCost, currentUnitCost)) {
        const documents = await db.collection("documents").find({}, { session }).toArray(), anchor = documents.findIndex(document => document.id === original.id);
        const corrections = documents.filter((document,index) => index > anchor && document.status === "posted" && document.perfumeStockOperationType === "yield-correction" && documentUsesPerfumeLot(document, productId, lot.id));
        throw perfumeOperationBlocked("لا يمكن إلغاء البيع القديم لأن تقييم الدفعة أو تكلفتها تغير بعده؛ ألغِ تصحيح الناتج المرتبط أولًا:", corrections);
      }
      lot.remainingQuantity = roundMl(Number(lot.remainingQuantity) + amount);
      lot.stocks = { ...lot.stocks, [wh]: roundMl(Number(lot.stocks[wh] ?? 0) + amount) };
      if (lot.remainingQuantity > lot.originalQuantity + Number(lot.quantityAdjustmentMl ?? 0) + 1e-8) throw conflict();
    }
  }
  for (const product of products.values()) {
    const lots = product.perfumeLots as PerfumeLot[];
    const warehouses = new Set([...Object.keys(product.stocks ?? {}), ...lots.flatMap(lot => Object.keys(lot.stocks))]);
    if ([...warehouses].some(wh => !equal(Number(product.stocks?.[wh] ?? 0), lots.reduce((sum, lot) => sum + Number(lot.stocks[wh] ?? 0), 0)))) throw conflict();
    await db.collection("products").updateOne({ id: product.id }, { $set: { perfumeLots: lots } }, { session });
  }
}

/** Validate reversibility inside the command transaction; never infer a physical gain/loss. */
export async function splitReversalEvidence(db: Db, session: Session, document: Row, product: Row, lot: PerfumeLot, lots: PerfumeLot[], incoming: Row, outgoing: Row) {
  const originalQuantity = Number(incoming.quantity), warehouseId = String(document.warehouseId);
  const related = await db.collection("documents").find({ "lines.productId": String(product.id), id: { $ne: document.id } }, { session }).toArray();
  let quantity = originalQuantity, costLot = lot, unitConversionId: string | null = null;
  if (lot.quantityUnit === "ml" && document.quantityUnit !== "ml") {
    const factor = Number(lot.legacyQuantityScaleMl);
    const migrations = related.filter(doc => doc.status === "posted" && doc.perfumeStockOperationType === "unit-conversion" &&
      doc.unitConversionBefore?.id === product.id && Number(doc.legacyPortionMl) === factor);
    if (migrations.length !== 1 || !Number.isFinite(factor) || factor <= 0) throw conflict();
    const migration = migrations[0];
    const before = (migration.unitConversionBefore.perfumeLots as PerfumeLot[]).find(item => item.id === lot.id);
    const after = (migration.unitConversionAfter?.perfumeLots as PerfumeLot[] | undefined)?.find(item => item.id === lot.id);
    if (!before || !after || before.quantityUnit === "ml" || before.originalQuantity !== originalQuantity) throw conflict();
    costLot = { ...before, remainingQuantity: originalQuantity, stocks: { [warehouseId]: originalQuantity } };
    quantity = roundMl(originalQuantity * factor);
    const fullAfter = { ...after, remainingQuantity: quantity, stocks: { [warehouseId]: quantity } };
    if (!perfumeLotEquals(lot, fullAfter) || document.perfumeLotAfter && !perfumeLotEquals(document.perfumeLotAfter, costLot)) throw conflict();
    unitConversionId = String(migration.id);
  } else if (document.perfumeLotAfter && !perfumeLotEquals(lot, document.perfumeLotAfter)) throw conflict();
  if (!Number.isFinite(quantity) || quantity <= 0 || Number(outgoing.quantity) !== -1 ||
      lot.conversionDocumentId !== document.id || lot.sourceProductId !== outgoing.productId ||
      lot.openingBalance || lot.recombinedAt || lot.settledAt || lot.originalQuantity !== quantity) throw conflict();
  if (related.some(doc => doc.status !== "voided" && documentUsesPerfumeLot(doc, String(product.id), lot.id))) throw conflict();

  const legacy = !document.perfumeLotAfter && costLot.quantityUnit !== "ml";
  const lineCost = Number(incoming.unitPrice), liquidCost = Number(costLot.liquidUnitCost), bottleCost = Number(costLot.bottleCost ?? 0);
  const legacyLanded = legacy && bottleCost > 0 && equal(lineCost, Number(costLot.landedUnitCost)) && equal(lineCost, liquidCost + bottleCost);
  if (!equal(lineCost, liquidCost) && !legacyLanded) throw conflict();

  const warehouseIds = new Set([...Object.keys(product.stocks ?? {}), ...lots.flatMap(item => Object.keys(item.stocks))]);
  const stockMatchesLots = [...warehouseIds].every(wh => equal(Number(product.stocks?.[wh] ?? 0), lots.reduce((sum, item) => sum + Number(item.stocks[wh] ?? 0), 0)));
  const untouched = equal(lot.remainingQuantity, quantity) && equal(values(lot.stocks), quantity) && equal(Number(lot.stocks[warehouseId] ?? 0), quantity);
  const evidence: Row = { quantityRemoved: quantity, sourceQuantityRestored: 1, sourceUnitCost: outgoing.unitPrice,
    lotBefore: structuredClone(lot), legacyLandedCost: legacyLanded, recoveredCancelledQuantity: 0, unitConversionId };
  if (untouched && stockMatchesLots) return evidence;

  // Older recombination reversal replaced the lot snapshot after a sale reversal,
  // dropping the restored allocation while visible stock and the ledger retained it.
  // Accept only a single legacy lot, fully reversed documents and an exact ledger.
  const missing = quantity - Number(lot.remainingQuantity);
  if (!legacy || unitConversionId || lots.length !== 1 || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(missing) || missing <= 0 ||
      !equal(values(lot.stocks), lot.remainingQuantity) || !equal(Number(lot.stocks[warehouseId] ?? 0), lot.remainingQuantity) ||
      !equal(values(product.stocks ?? {}), quantity) || !equal(Number(product.stocks?.[warehouseId] ?? 0), quantity) ||
      related.some(doc => doc.status !== "voided")) throw conflict();

  const cancelledSales = related.filter(doc => ["sale", "decant-sale"].includes(doc.kind));
  const restored = cancelledSales.flatMap(doc => (doc.lines as Row[]).filter(line => line.productId === product.id)
    .flatMap(line => Array.isArray(line.perfumeAllocations) ? line.perfumeAllocations as Row[] : []))
    .filter(allocation => allocation.lotId === lot.id && allocation.warehouseId === warehouseId)
    .reduce((sum, allocation) => sum + Number(allocation.quantity), 0);
  if (!equal(restored, missing)) throw conflict();
  const partialIds = related.filter(doc => doc.perfumeConversionType === "perfume-recombine")
    .flatMap(doc => (doc.lines as Row[]).filter(line => Number(line.quantity) > 0).map(line => String(line.productId)));
  if (partialIds.length && await db.collection("documents").findOne({ status: { $ne: "voided" }, "lines.productId": { $in: partialIds } }, { session })) throw conflict();

  const byId = new Map([document, ...related].map(doc => [doc.id, doc]));
  const movements = await db.collection("stockMovements").find({ productId: product.id }, { session }).toArray();
  const nets = new Map<string, { documentId: string; warehouseId: string; quantity: number }>();
  for (const movement of movements) {
    if (!byId.has(movement.documentId) || !Number.isFinite(Number(movement.quantityDelta))) throw conflict();
    const key = JSON.stringify([movement.documentId, movement.warehouseId]);
    const previous = nets.get(key)?.quantity ?? 0;
    nets.set(key, { documentId: movement.documentId, warehouseId: movement.warehouseId, quantity: roundMl(previous + Number(movement.quantityDelta)) });
  }
  if (![...nets.values()].some(net => net.documentId === document.id && net.warehouseId === warehouseId && equal(net.quantity, quantity)) ||
      [...nets.values()].some(net => !equal(net.quantity, net.documentId === document.id && net.warehouseId === warehouseId ? quantity : 0))) throw conflict();
  return { ...evidence, recoveredCancelledQuantity: missing, cancelledSaleIds: cancelledSales.map(doc => doc.id), ledgerVerified: true };
}
