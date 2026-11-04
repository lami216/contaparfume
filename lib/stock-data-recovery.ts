import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./sqlite.ts";
import { stockNumber } from "./stock-numbers.ts";
import { createStockRecoverySafetySnapshot } from "./stock-recovery-safety.ts";

export const STOCK_DATA_RECOVERY_VERSION = 1;
export const STOCK_DATA_RECOVERY_ACTION = "stock-data-recovery.automatic";
type Row = Record<string, unknown>;
export type StockRecoveryStoredRow = { record_key: string; data_json: string; rowid: number; value: Row };
export type StockRecoverySnapshot = { products: StockRecoveryStoredRow[]; documents: StockRecoveryStoredRow[]; stockMovements: StockRecoveryStoredRow[]; warehouses: StockRecoveryStoredRow[] };
type Repair = {
  product: StockRecoveryStoredRow; movement: StockRecoveryStoredRow; source: StockRecoveryStoredRow;
  warehouseId: string; beforeStock: string; afterStock: number;
  kind: "quantity-correction" | "type-normalization"; proof: Row;
};
export type StockRecoveryPlan = { version: 1; repairs: Repair[]; skipped: number; reasons: Record<string, number> };
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
const imported = (value: Row) => Boolean(value.legacyKey || value.legacy || value.importRunId || value.importedFrom || value.sourceType || value.sourceEntityType || value.sourceKey);
const derivative = (value: Row) => ["decant", "bottle", "partial"].includes(String(value.perfumeForm)) ||
  (Array.isArray(value.perfumeLots) && value.perfumeLots.length > 0) || Boolean(value.parentProductId || value.sourceProductId) || value.perfumeStockUnit === "ml" ||
  ["decantSizeMl", "partialVolumeMl", "partialRemainingParts", "partialOriginalParts", "legacyDecantUnitMl", "decantPriceBasisMl"].some(name => value[name] !== undefined && value[name] !== null);
const liquidLine = (value: Row) => Boolean(value.bottleProductId || value.perfumeAllocations || value.bottleAllocations || value.liquidQuantityMl !== undefined || value.fillMl !== undefined);
const quantity = (value: unknown) => { const number = stockNumber(value); return number !== null && number > 0 ? number : null; };
const docRevision = (document: Row) => document.revision === undefined ? 0 : typeof document.revision === "number" && Number.isSafeInteger(document.revision) && document.revision >= 0 ? document.revision : null;
const movementRevision = (movement: Row) => typeof movement.documentRevision === "number" && Number.isSafeInteger(movement.documentRevision) ? movement.documentRevision : null;
const isoDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function uniqueById(rows: StockRecoveryStoredRow[], warehouse = false) {
  const map = new Map<string, StockRecoveryStoredRow | null>();
  for (const row of rows) {
    const id = warehouse ? row.value._id ?? row.value.id : row.value.id;
    if (warehouse && (row.record_key !== id || row.value._id !== undefined && row.value.id !== undefined && row.value._id !== row.value.id)) continue;
    if (!key(id)) continue;
    map.set(id, map.has(id) ? null : row);
  }
  return map;
}
function lines(document: Row): Row[] | null {
  if (!Array.isArray(document.lines) || document.lines.length === 0 || document.lines.some(line => !record(line) || !key(line.productId) || quantity(line.quantity) === null || liquidLine(line))) return null;
  const result = document.lines as Row[];
  return new Set(result.map(line => line.productId)).size === result.length ? result : null;
}
function concatenation(movement: Row) {
  if (movement.type !== "sale-void" || typeof movement.balanceBefore !== "number" || !Number.isFinite(movement.balanceBefore) || movement.balanceBefore < 0 || typeof movement.quantityDelta !== "string" || typeof movement.balanceAfter !== "string") return null;
  const delta = quantity(movement.quantityDelta), numericAfter = stockNumber(movement.balanceAfter);
  if (delta === null || numericAfter === null || numericAfter < 0 || movement.balanceAfter !== String(movement.balanceBefore) + movement.quantityDelta) return null;
  const corrected = movement.balanceBefore + delta;
  return Number.isFinite(corrected) ? { delta, corrected, numericAfter } : null;
}

/** A bounded historical proof, not a stock rebuild. Only terminal sale-void
 * concatenation is eligible. Every earlier native movement must establish an
 * uninterrupted, arithmetically correct chain from zero. Unknown history stays
 * untouched; business dates alone never establish posting order. */
export function planHistoricalStockRecovery(state: StockRecoverySnapshot): StockRecoveryPlan {
  const result: StockRecoveryPlan = { version: 1, repairs: [], skipped: 0, reasons: {} };
  const skip = (reason: string) => { result.skipped++; result.reasons[reason] = (result.reasons[reason] ?? 0) + 1; };
  const products = uniqueById(state.products), documents = uniqueById(state.documents), warehouses = uniqueById(state.warehouses, true);
  const cells = new Map<string, StockRecoveryStoredRow[]>(), documentMoves = new Map<string, StockRecoveryStoredRow[]>(), parentIds = new Set<unknown>(), movementIds = new Map<unknown, number>();
  const sorted = [...state.stockMovements].sort((a, b) => a.rowid - b.rowid);
  const validOrder = sorted.every((row, index) => Number.isSafeInteger(row.rowid) && row.rowid > 0 && (index === 0 || sorted[index - 1].rowid !== row.rowid));
  for (const document of state.documents) if (document.value.parentDocumentId) parentIds.add(document.value.parentDocumentId);
  for (const movement of sorted) {
    const value = movement.value, cell = JSON.stringify([value.productId, value.warehouseId]), rows = cells.get(cell) ?? [];
    movementIds.set(value.id, (movementIds.get(value.id) ?? 0) + 1);
    rows.push(movement); cells.set(cell, rows);
    if (key(value.documentId)) { const all = documentMoves.get(value.documentId) ?? []; all.push(movement); documentMoves.set(value.documentId, all); }
  }
  const sourceCache = new Map<string, boolean>();
  function provenSource(source: StockRecoveryStoredRow): boolean {
    const document = source.value, id = String(document.id);
    if (sourceCache.has(id)) return sourceCache.get(id)!;
    sourceCache.set(id, false);
    const items = lines(document), revision = docRevision(document), rows = documentMoves.get(id) ?? [];
    if (!items || imported(document) || document.parentDocumentId || parentIds.has(id) || !key(document.warehouseId) || !warehouses.get(document.warehouseId) || !key(document.number) || !isoDate(document.occurredAt)) return false;
    const initialOpening = document.kind === "adjustment" && /^OPEN-(?!COR)/.test(document.number) && document.openingCorrection !== true && items.length === 1;
    const isCommerce = document.kind === "sale" || document.kind === "purchase";
    const voided = document.status === "voided";
    if ((!initialOpening && !isCommerce) || (initialOpening && (document.status !== "posted" || revision !== 0)) || (isCommerce && !(document.status === "posted" && revision === 0 || voided && revision === 1 && isoDate(document.voidedAt)))) return false;
    if (rows.length !== items.length * (voided ? 2 : 1)) return false;
    for (const line of items) {
      const product = products.get(String(line.productId)), count = quantity(line.quantity)!;
      if (!product || imported(product.value) || derivative(product.value) || line.warehouseId !== undefined && line.warehouseId !== document.warehouseId) return false;
      const matching = rows.filter(row => row.value.productId === line.productId);
      if (matching.length !== (voided ? 2 : 1) || matching.some(row => row.value.warehouseId !== document.warehouseId || row.value.documentNumber !== document.number || !key(row.value.id) || movementIds.get(row.value.id) !== 1 || !isoDate(row.value.occurredAt))) return false;
      const original = matching.find(row => row.value.type === (initialOpening ? "opening" : document.kind));
      if (!original || movementRevision(original.value) !== 0 || typeof original.value.quantityDelta !== "number" || original.value.quantityDelta !== (document.kind === "sale" ? -count : count)) return false;
      if (initialOpening && (stockNumber(document.openingStockAfter) !== count || original.value.balanceBefore !== 0)) return false;
      if (voided) {
        const reverse = matching.find(row => row.value.type === `${String(document.kind)}-void`);
        if (!reverse || reverse.rowid <= original.rowid || movementRevision(reverse.value) !== 1 || stockNumber(reverse.value.quantityDelta) !== (document.kind === "sale" ? count : -count)) return false;
        // The actual bug passes the saved string unchanged. A fabricated string
        // reversal of a numeric source line is not evidence of that old path.
        if (typeof reverse.value.quantityDelta === "string" && (document.kind !== "sale" || reverse.value.quantityDelta !== line.quantity || !concatenation(reverse.value))) return false;
      }
    }
    sourceCache.set(id, true); return true;
  }
  for (const cell of cells.values()) {
    if (!cell.some(row => row.value.type === "sale-void" && (typeof row.value.quantityDelta === "string" || typeof row.value.balanceAfter === "string"))) continue;
    if (!validOrder) { skip("ambiguous-movement-order"); continue; }
    const terminal = cell.at(-1)!, movement = terminal.value, signature = concatenation(movement);
    if (!signature) { skip("not-terminal-concatenation"); continue; }
    const product = products.get(String(movement.productId)), source = documents.get(String(movement.documentId));
    if (!product || !source || !key(movement.warehouseId) || !warehouses.get(movement.warehouseId) || imported(product.value) || derivative(product.value)) { skip("unsupported-product-or-source"); continue; }
    if (!record(product.value.stocks) || !Object.hasOwn(product.value.stocks, movement.warehouseId) || product.value.stocks[movement.warehouseId] !== movement.balanceAfter) { skip("current-stock-does-not-match"); continue; }
    if (!provenSource(source) || source.value.kind !== "sale" || source.value.status !== "voided" || docRevision(source.value) !== 1) { skip("unproven-source-void"); continue; }
    let previous = 0, reason = "";
    for (const row of cell) {
      const value = row.value, before = stockNumber(value.balanceBefore), delta = stockNumber(value.quantityDelta), after = stockNumber(value.balanceAfter), document = documents.get(String(value.documentId));
      if (before === null || delta === null || after === null || before < 0 || after < 0 || !Number.isFinite(before + delta) || before !== previous) { reason = "incomplete-stock-chain"; break; }
      if (!document || !provenSource(document)) { reason = "unsupported-stock-history"; break; }
      if (row === terminal) {
        if (typeof value.balanceBefore !== "number" || value.quantityDelta !== (lines(source.value)!.find(line => line.productId === movement.productId)!.quantity)) reason = "unproven-source-quantity";
      } else if (before + delta !== after) { reason = "earlier-arithmetic-drift"; break; }
      previous = after;
    }
    if (reason) { skip(reason); continue; }
    const sourceRows = documentMoves.get(String(source.value.id))!, original = sourceRows.find(row => row.value.productId === movement.productId && row.value.type === "sale")!;
    const itemLines = lines(source.value)!, lineIndex = itemLines.findIndex(line => line.productId === movement.productId);
    result.repairs.push({ product, movement: terminal, source, warehouseId: movement.warehouseId, beforeStock: movement.balanceAfter as string, afterStock: signature.corrected,
      kind: signature.corrected === signature.numericAfter ? "type-normalization" : "quantity-correction",
      proof: { rule: "terminal-native-sale-void-concatenation", sourceRevision: 1, sourceLineIndex: lineIndex, sourceLineId: itemLines[lineIndex].id ?? null, savedQuantity: itemLines[lineIndex].quantity, originalSaleMovementId: original.value.id, anchorMovementId: cell[0].value.id, precedingMovementIds: cell.slice(0, -1).map(row => row.value.id), arithmeticBefore: movement.balanceBefore, arithmeticDelta: signature.delta, arithmeticAfter: signature.corrected } });
  }
  return result;
}

function readRows(db: SqliteDatabase, table: "products" | "documents" | "stock_movements" | "warehouses"): StockRecoveryStoredRow[] {
  return (db.native.prepare(`SELECT record_key,data_json,rowid FROM ${table} ORDER BY rowid`).all() as Omit<StockRecoveryStoredRow, "value">[]).map(row => ({ ...row, value: JSON.parse(row.data_json) as Row }));
}
function atomic<T>(db: SqliteDatabase, work: () => T): T {
  const nested = db.native.inTransaction, point = `stock_recovery_${randomUUID().replaceAll("-", "")}`;
  db.native.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try { const result = work(); db.native.exec(nested ? `RELEASE SAVEPOINT ${point}` : "COMMIT"); return result; }
  catch (error) { if (nested) { db.native.exec(`ROLLBACK TO SAVEPOINT ${point}`); db.native.exec(`RELEASE SAVEPOINT ${point}`); } else if (db.native.inTransaction) db.native.exec("ROLLBACK"); throw error; }
}

/** Startup and restore may retry this additive repair. Fixed movement metadata is
 * its idempotence witness; no global marker can hide an older restored backup. */
export function recoverHistoricalStockData(db: SqliteDatabase, options: { context?: string } = {}) {
  return atomic(db, () => {
    const empty = { version: STOCK_DATA_RECOVERY_VERSION, repaired: 0, quantityCorrected: 0, typeNormalized: 0, skipped: 0, reasons: {} as Record<string, number> };
    // Healthy profiles do not load the entire history, write markers or create
    // safety files. The expensive proof runs only for an actual string witness.
    const suspected = db.native.prepare("SELECT 1 FROM stock_movements WHERE json_extract(data_json,'$.type')='sale-void' AND (json_type(data_json,'$.quantityDelta')='text' OR json_type(data_json,'$.balanceAfter')='text') LIMIT 1").get();
    if (!suspected) return empty;
    const plan = planHistoricalStockRecovery({ products: readRows(db, "products"), documents: readRows(db, "documents"), stockMovements: readRows(db, "stock_movements"), warehouses: readRows(db, "warehouses") });
    const summary = { ...empty, skipped: plan.skipped, reasons: plan.reasons };
    if (!plan.repairs.length) return summary;
    const context = options.context ?? "startup", safetySnapshot = createStockRecoverySafetySnapshot(db, { context });
    const currentProducts = new Map<string, { raw: string; value: Row }>();
    for (const repair of plan.repairs) {
      const before = currentProducts.get(repair.product.record_key) ?? { raw: repair.product.data_json, value: repair.product.value };
      const afterProduct = structuredClone(before.value), afterMovement = structuredClone(repair.movement.value);
      (afterProduct.stocks as Row)[repair.warehouseId] = repair.afterStock;
      afterMovement.quantityDelta = stockNumber(afterMovement.quantityDelta)!; afterMovement.balanceAfter = repair.afterStock;
      const afterProductRaw = JSON.stringify(afterProduct), afterMovementRaw = JSON.stringify(afterMovement);
      const productWrite = db.native.prepare("UPDATE products SET data_json=? WHERE record_key=? AND data_json=?").run(afterProductRaw, repair.product.record_key, before.raw);
      const movementWrite = db.native.prepare("UPDATE stock_movements SET data_json=? WHERE record_key=? AND data_json=?").run(afterMovementRaw, repair.movement.record_key, repair.movement.data_json);
      if (productWrite.changes !== 1 || movementWrite.changes !== 1) throw new Error("تغير سجل المخزون أثناء استعادة بياناته؛ أعد تشغيل التطبيق للمحاولة من جديد");
      const id = `stock-recovery-${randomUUID()}`;
      db.native.prepare("INSERT INTO audit_events(record_key,data_json) VALUES(?,?)").run(id, JSON.stringify({ id, _id: id, action: STOCK_DATA_RECOVERY_ACTION, version: STOCK_DATA_RECOVERY_VERSION, status: "committed", actor: { principalType: "system", name: "safe-stock-data-recovery" }, createdAt: new Date().toISOString(), context, entityId: repair.product.value.id, documentId: repair.source.value.id, warehouseId: repair.warehouseId, kind: repair.kind, beforeProductRaw: before.raw, afterProductRaw, beforeMovementRaw: repair.movement.data_json, afterMovementRaw, beforeProduct: before.value, afterProduct, beforeMovement: repair.movement.value, afterMovement, sourceDocumentRaw: repair.source.data_json, sourceDocument: repair.source.value, proof: repair.proof, safetySnapshot }));
      currentProducts.set(repair.product.record_key, { raw: afterProductRaw, value: afterProduct });
      summary.repaired++; if (repair.kind === "quantity-correction") summary.quantityCorrected++; else summary.typeNormalized++;
    }
    return { ...summary, safetySnapshot };
  });
}
