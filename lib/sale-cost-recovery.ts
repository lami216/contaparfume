import { createHash, randomUUID } from "node:crypto";
import type { DbDocument, SqliteDatabase } from "./sqlite.ts";
import { reportCostNumber, reportNetLines } from "./report-commerce.ts";

export const SALE_COST_RECOVERY_VERSION = 1;
export const SALE_COST_RECOVERY_SETTING = "sale-cost-recovery:v1";
type Row = DbDocument;
type Stored = { record_key: string; data_json: string; rowid: number; value: Row };
type Actor = { principalType: string; name: string; userId?: string };
type Source = { documentId: string; number: string; lineId: string; unitCost: number; kind: string; occurredAt: string; fingerprint: string };
type Resolution = { source: Source | null; reason: string };
type Candidate = { document: Stored; line: Row; index: number; product: Row | undefined; state: "missing" | "invalid" | "saved-zero"; resolution: Resolution; token: string; lineId: string; revenue: number | null; reviewed: boolean };
export class SaleCostRecoveryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const lines = (document: Row): Row[] => Array.isArray(document.lines) ? document.lines.filter(record) : [];
const imported = (document: Row) => Boolean(document.legacyKey || document.legacy || document.importRunId || document.importedFrom || document.sourceType === "dataacc-sqlite");
const liquidEvidence = (line: Row) => Boolean(line.bottleProductId || line.perfumeAllocations || line.bottleAllocations || line.liquidQuantityMl !== undefined || line.fillMl !== undefined);
const generatedPerfumeEvidence = (product: Row) =>
  (Array.isArray(product.perfumeLots) && product.perfumeLots.length > 0) ||
  Boolean(text(product.parentProductId) || text(product.sourceProductId)) ||
  product.perfumeStockUnit === "ml" ||
  ["decantSizeMl", "partialVolumeMl", "partialRemainingParts", "partialOriginalParts", "legacyDecantUnitMl", "decantPriceBasisMl"].some(key => product[key] !== undefined && product[key] !== null);
// Old generated products may predate perfumeForm. Their lot/link/unit evidence
// still owns cost; ordinary bottle volume metadata alone does not make a derivative.
const ordinary = (product: Row | undefined, line: Row) => Boolean(product && !["decant", "bottle", "partial"].includes(String(product.perfumeForm)) && !generatedPerfumeEvidence(product) && !liquidEvidence(line));
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const revision = (document: Row) => Number.isSafeInteger(Number(document.revision ?? 0)) && Number(document.revision ?? 0) >= 0 ? Number(document.revision ?? 0) : null;
function readRows(db: SqliteDatabase, table: "documents" | "products" | "app_settings" | "audit_events") {
  const where = table === "audit_events" ? " WHERE json_extract(data_json,'$.action')='sale-cost-recovery.confirm' AND json_extract(data_json,'$.version')=1" : "";
  return (db.native.prepare(`SELECT record_key,data_json,rowid FROM ${table}${where} ORDER BY rowid`).all() as Omit<Stored, "value">[]).map(row => ({ ...row, value: JSON.parse(row.data_json) as Row }));
}
function snapshot(db: SqliteDatabase) {
  const documents = readRows(db, "documents"), products = readRows(db, "products");
  const reviewedZeros = new Set<string>();
  for (const { value: event } of readRows(db, "audit_events")) {
    if (event.action !== "sale-cost-recovery.confirm" || event.version !== SALE_COST_RECOVERY_VERSION || !["owner", "local"].includes(String(event.actor?.principalType)) || !record(event.afterDocument)) continue;
    const savedLine = event.afterDocument.lines?.[event.lineIndex];
    if (!record(savedLine) || savedLine.saleCostRecovery?.action !== "confirm-zero" || reportCostNumber(savedLine.costAtSale) !== 0) continue;
    reviewedZeros.add(zeroIdentity(event.afterDocument, savedLine, String(event.lineId)));
  }
  const sources = new Map<string, Stored[]>();
  for (const document of documents) if (document.value.kind === "purchase" || document.value.kind === "adjustment") {
    for (const productId of new Set(lines(document.value).map(line => String(line.productId)))) {
      const rows = sources.get(productId) ?? []; rows.push(document); sources.set(productId, rows);
    }
  }
  return { documents, sources, reviewedZeros, products: new Map(products.map(row => [String(row.value.id), row.value])), fingerprint: hash([SALE_COST_RECOVERY_VERSION, documents.map(row => [row.record_key, row.data_json]), products.map(row => [row.record_key, row.data_json])]) };
}
const zeroIdentity = (document: Row, line: Row, lineId: string) => hash([document.id, document.occurredAt, lineId, line.productId, line.costAtSale, line.quantity, line.unitPrice, line.lineTotal]);
function saleRevenue(document: Row, index: number) {
  const all = lines(document), total = reportCostNumber(document.total), amounts = all.map(line => reportCostNumber(line.lineTotal));
  if (all.length !== document.lines?.length || total === null || amounts.some(amount => amount === null) || total > amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) + 1e-7) return null;
  return reportCostNumber(reportNetLines(document)[index]?.lineTotal);
}

/** Recovery needs stronger proof than a read-only report estimate. Never consult
 * today's product price/cache, skip an unknown newest source, or infer imported chronology. */
function resolveSource(documents: Stored[], sale: Stored, line: Row): Resolution {
  const at = timestamp(sale.value.occurredAt);
  if (!at || imported(sale.value)) return { source: null, reason: "unsupported-import-or-date" };
  const relevant = documents.filter(row => lines(row.value).some(item => item.productId === line.productId));
  // The live cost resolver can see a source posted before the sale even when its
  // business date was malformed/backdated. Such contradictory chronology is not
  // permission to hydrate a cheaper older/opening cost.
  if (relevant.some(row => row.value.kind === "purchase" && row.rowid < sale.rowid && (!timestamp(row.value.occurredAt) || String(row.value.occurredAt) > at))) return { source: null, reason: "source-history-unproven" };
  const prior = (row: Stored) => Boolean(timestamp(row.value.occurredAt) && String(row.value.occurredAt) <= at);
  const purchases = relevant.filter(row => row.value.kind === "purchase" && prior(row));
  const openings = relevant.filter(row => row.value.kind === "adjustment" && (row.value.openingCorrection === true || /^OPEN-(?!COR)/.test(String(row.value.number ?? ""))) && prior(row));
  const sources = purchases.length ? purchases : openings;
  sources.sort((a, b) => String(a.value.occurredAt).localeCompare(String(b.value.occurredAt)) || Number(a.value.sequence ?? 0) - Number(b.value.sequence ?? 0));
  const latest = sources.at(-1);
  if (!latest) return { source: null, reason: "no-prior-source" };
  const ties = sources.filter(row => row.value.occurredAt === latest.value.occurredAt && Number(row.value.sequence ?? 0) === Number(latest.value.sequence ?? 0));
  if (ties.length !== 1) return { source: null, reason: "ambiguous-source-order" };
  // A purchase canceled after the sale can still have determined its original
  // missing snapshot. Falling back to older/opening cost would silently reprice it.
  if (latest.value.status !== "posted") return { source: null, reason: "source-history-unproven" };
  if (latest.rowid >= sale.rowid) return { source: null, reason: "source-posted-after-sale" };
  if (imported(latest.value) || Number(latest.value.revision ?? 0) !== 0 || (latest.value.updatedAt && String(latest.value.updatedAt) > at)) return { source: null, reason: "source-history-unproven" };
  const matching = lines(latest.value).filter(item => item.productId === line.productId);
  if (matching.length !== 1 || liquidEvidence(matching[0])) return { source: null, reason: "ambiguous-source-line" };
  const sourceLine = matching[0], unitCost = reportCostNumber(latest.value.kind === "purchase" ? sourceLine.unitPrice : latest.value.openingCostAfter ?? sourceLine.unitPrice);
  if (unitCost === null || unitCost <= 0) return { source: null, reason: "latest-source-cost-unknown" };
  if (latest.value.kind === "purchase") {
    const quantity = reportCostNumber(sourceLine.quantity), amount = reportCostNumber(sourceLine.lineTotal), all = lines(latest.value), total = reportCostNumber(latest.value.total);
    const sum = all.reduce((value, item) => { const n = reportCostNumber(item.lineTotal); return n === null ? NaN : value + n; }, 0);
    if (quantity === null || quantity <= 0 || amount === null || Math.abs(amount - Math.round(quantity * unitCost)) > 1e-7 || total === null || Math.abs(total - sum) > 1e-7) return { source: null, reason: "source-values-unproven" };
  } else {
    // A stale price on a zero/cleared opening is not evidence that stock existed.
    // Correction deltas may be negative, so prefer its saved absolute target.
    const quantity = reportCostNumber(Object.hasOwn(latest.value, "openingStockAfter") ? latest.value.openingStockAfter : sourceLine.quantity);
    if (quantity === null || quantity <= 0) return { source: null, reason: "source-values-unproven" };
  }
  return { source: { documentId: String(latest.value.id), number: String(latest.value.number ?? ""), lineId: String(sourceLine.id ?? ""), unitCost, kind: String(latest.value.kind), occurredAt: String(latest.value.occurredAt), fingerprint: hash(latest.value) }, reason: "proven-prior-source" };
}
function candidates(state: ReturnType<typeof snapshot>): Candidate[] {
  const result: Candidate[] = [];
  for (const document of state.documents) {
    const sale = document.value;
    if (sale.kind !== "sale" || sale.status !== "posted" || !Array.isArray(sale.lines) || revision(sale) === null) continue;
    for (let index = 0; index < sale.lines.length; index++) {
      const line = sale.lines[index];
      if (!record(line)) continue;
      const cost = reportCostNumber(line.costAtSale), product = state.products.get(String(line.productId));
      if (!ordinary(product, line) || (cost !== null && cost > 0)) continue;
      const stateName = cost === 0 ? "saved-zero" : line.costAtSale === null || line.costAtSale === undefined ? "missing" : "invalid";
      const quantity = reportCostNumber(line.quantity), revenue = saleRevenue(sale, index);
      let resolution = quantity === null || quantity <= 0 || revenue === null ? { source: null, reason: "sale-values-unproven" } : resolveSource(state.sources.get(String(line.productId)) ?? [], document, line);
      if (resolution.source && !Number.isFinite(Number(line.quantity) * resolution.source.unitCost)) resolution = { source: null, reason: "sale-values-unproven" };
      const lineId = text(line.id) && sale.lines.filter((item: Row) => item?.id === line.id).length === 1 ? text(line.id) : `legacy-index:${index}`;
      // General invoice edits may omit additive line metadata. The durable owner
      // journal remains authoritative while the complete saved stock/price tuple agrees.
      const reviewed = cost === 0 && state.reviewedZeros.has(zeroIdentity(sale, line, lineId));
      const token = hash([SALE_COST_RECOVERY_VERSION, sale, index, product?.perfumeForm ?? null, resolution]);
      result.push({ document, line, index, product, state: stateName, resolution, token, lineId, revenue, reviewed });
    }
  }
  return result;
}
function setting(db: SqliteDatabase) { const row = db.native.prepare("SELECT data_json FROM app_settings WHERE record_key=?").get(SALE_COST_RECOVERY_SETTING) as { data_json: string } | undefined; return row ? JSON.parse(row.data_json) as Row : null; }
function saveSetting(db: SqliteDatabase, value: Row) { db.native.prepare("INSERT INTO app_settings(record_key,data_json) VALUES(?,?) ON CONFLICT(record_key) DO UPDATE SET data_json=excluded.data_json").run(SALE_COST_RECOVERY_SETTING, JSON.stringify({ ...value, id: SALE_COST_RECOVERY_SETTING, _id: SALE_COST_RECOVERY_SETTING })); }
function journal(db: SqliteDatabase, action: string, beforeDocument: Row, afterDocument: Row, candidate: Candidate, actor: Actor, reason: string, ownerReviewed = false) {
  const id = `sale-cost-recovery-${randomUUID()}`;
  db.native.prepare("INSERT INTO audit_events(record_key,data_json) VALUES(?,?)").run(id, JSON.stringify({ id, _id: id, action, version: SALE_COST_RECOVERY_VERSION, status: "committed", createdAt: new Date().toISOString(), entityId: beforeDocument.id, lineId: candidate.lineId, lineIndex: candidate.index, actor, reason, sourceType: ownerReviewed ? "owner-reviewed" : "proven-prior-source", source: ownerReviewed ? null : candidate.resolution.source, beforeDocument, afterDocument }));
}
function apply(db: SqliteDatabase, candidate: Candidate, cost: number, actor: Actor, action: "automatic" | "apply-suggested" | "confirm-zero" | "set-reviewed-cost", reason: string) {
  const before = candidate.document.value, after = structuredClone(before), line = after.lines[candidate.index];
  if (!Number.isFinite(Number(line.quantity) * cost) || !Number.isFinite(candidate.revenue! - Number(line.quantity) * cost)) throw new SaleCostRecoveryError("تكلفة الوحدة التي راجعتها يجب أن تكون رقمًا موجبًا صالحًا");
  line.costAtSale = cost;
  line.grossProfit = candidate.revenue! - Number(line.quantity) * cost;
  const ownerReviewed = action === "set-reviewed-cost" || action === "confirm-zero";
  line.saleCostRecovery = { version: SALE_COST_RECOVERY_VERSION, action, at: new Date().toISOString(), sourceType: ownerReviewed ? "owner-reviewed" : "proven-prior-source", sourceDocumentId: ownerReviewed ? null : candidate.resolution.source?.documentId ?? null, snapshot: hash([line.costAtSale, line.quantity, line.unitPrice, line.lineTotal]) };
  // Automatic hydration leaves business and revision timestamps intact. An explicit
  // owner correction is a revision, but never a replacement stock/financial posting.
  if (action !== "automatic") { after.revision = Number(before.revision ?? 0) + 1; after.updatedAt = new Date().toISOString(); }
  journal(db, action === "automatic" ? "sale-cost-recovery.automatic" : "sale-cost-recovery.confirm", before, after, candidate, actor, reason, ownerReviewed);
  const updated = db.native.prepare("UPDATE documents SET data_json=? WHERE record_key=? AND data_json=?").run(JSON.stringify(after), candidate.document.record_key, candidate.document.data_json);
  if (updated.changes !== 1) throw new SaleCostRecoveryError("تغيرت الفاتورة أثناء مراجعة التكلفة؛ حدّث القائمة وأعد المحاولة", 409);
  candidate.document.data_json = JSON.stringify(after); candidate.document.value = after;
  return after;
}
function atomic<T>(db: SqliteDatabase, work: () => T): T {
  if (db.native.inTransaction) {
    const point = `sale_cost_recovery_${randomUUID().replaceAll("-", "")}`;
    db.native.exec(`SAVEPOINT ${point}`);
    try { const result = work(); db.native.exec(`RELEASE SAVEPOINT ${point}`); return result; }
    catch (error) { db.native.exec(`ROLLBACK TO SAVEPOINT ${point}`); db.native.exec(`RELEASE SAVEPOINT ${point}`); throw error; }
  }
  db.native.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.native.exec("COMMIT"); return result; }
  catch (error) { if (db.native.inTransaction) db.native.exec("ROLLBACK"); throw error; }
}

/** Runs once per changed dataset, inside a single SQLite transaction. The durable
 * before-image journal and marker travel with native backups; no external profile is read. */
export function recoverHistoricalSaleCosts(db: SqliteDatabase, options: { context?: string } = {}) {
  return atomic(db, () => {
    const state = snapshot(db), prior = setting(db);
    if (prior?.version === SALE_COST_RECOVERY_VERSION && prior.fingerprint === state.fingerprint) return readSaleCostRecoverySummary(db);
    let recovered = 0;
    for (const candidate of candidates(state)) {
      if (candidate.state === "saved-zero" || !candidate.resolution.source || candidate.revenue === null) continue;
      apply(db, candidate, candidate.resolution.source.unitCost, { principalType: "system", name: "safe-cost-recovery" }, "automatic", "proven-prior-native-source"); recovered++;
    }
    // An untouched dataset needs no migration metadata. In particular, restoring
    // a backup without a recovery marker must preserve its settings byte-for-byte.
    if (recovered === 0 && !prior) return readSaleCostRecoverySummary(db);
    const final = snapshot(db);
    saveSetting(db, { version: SALE_COST_RECOVERY_VERSION, fingerprint: final.fingerprint, automaticRecovered: Number(prior?.automaticRecovered ?? 0) + recovered, lastRecovered: recovered, completedAt: new Date().toISOString(), context: options.context ?? "startup" });
    return readSaleCostRecoverySummary(db);
  });
}
export function readSaleCostRecoverySummary(db: SqliteDatabase) {
  return summary(db, candidates(snapshot(db)));
}
function summary(db: SqliteDatabase, all: Candidate[]) {
  const rows = all.filter(row => !row.reviewed);
  return { automaticRecovered: Number(setting(db)?.automaticRecovered ?? 0), unresolved: rows.filter(row => row.state !== "saved-zero").length, savedZeroReview: rows.filter(row => row.state === "saved-zero").length, reviewedZero: all.filter(row => row.reviewed).length };
}
export function accountingHealth(db: SqliteDatabase, options: { page?: number; pageSize?: number } = {}) {
  const page = options.page ?? 1, pageSize = options.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new SaleCostRecoveryError("إعدادات صفحة مراجعة التكاليف غير صالحة");
  const candidatesAll = candidates(snapshot(db)), all = candidatesAll.filter(row => !row.reviewed);
  const rows = all.slice((page - 1) * pageSize, page * pageSize).map(row => ({ documentId: String(row.document.value.id), number: String(row.document.value.number ?? ""), lineId: row.lineId, lineIndex: row.index, productId: String(row.line.productId), productName: String(row.product?.name ?? row.line.description ?? ""), occurredAt: String(row.document.value.occurredAt ?? ""), revision: Number(row.document.value.revision ?? 0), originalCost: row.line.costAtSale ?? null, costState: row.state, suggestedPriorCost: row.resolution.source?.unitCost ?? null, sourceDocumentId: row.resolution.source?.documentId ?? null, sourceNumber: row.resolution.source?.number ?? null, reason: row.resolution.reason, canApplySuggested: row.resolution.source !== null && row.revenue !== null, canConfirmZero: row.revenue !== null && (reportCostNumber(row.line.quantity) ?? 0) > 0, canSetReviewedCost: row.revenue !== null && (reportCostNumber(row.line.quantity) ?? 0) > 0, reviewToken: row.token }));
  return { version: SALE_COST_RECOVERY_VERSION, summary: summary(db, candidatesAll), rows, pagination: { page, pageSize, totalRows: all.length, totalPages: Math.max(1, Math.ceil(all.length / pageSize)) } };
}
export function confirmSaleCostRecovery(db: SqliteDatabase, body: Row, actor: Actor) {
  if (!["owner", "local"].includes(actor.principalType)) throw new SaleCostRecoveryError("مراجعة تكاليف المبيعات متاحة للمالك فقط", 403);
  const action = text(body.action), reason = text(body.reason);
  if (!["apply-suggested", "confirm-zero", "set-reviewed-cost"].includes(action) || !reason || reason.length > 1000) throw new SaleCostRecoveryError("اختر إجراء المراجعة واكتب سببًا واضحًا لا يتجاوز 1000 حرف");
  const reviewedCost = reportCostNumber(body.reviewedUnitCost);
  if (action === "set-reviewed-cost" && (reviewedCost === null || reviewedCost <= 0)) throw new SaleCostRecoveryError("تكلفة الوحدة التي راجعتها يجب أن تكون رقمًا موجبًا صالحًا");
  return atomic(db, () => {
    const state = snapshot(db), candidate = candidates(state).find(row => String(row.document.value.id) === text(body.documentId) && row.lineId === text(body.lineId));
    if (!candidate || candidate.reviewed) throw new SaleCostRecoveryError("السطر غير متاح لمراجعة التكلفة أو تمت مراجعته بالفعل", 409);
    if (typeof body.expectedRevision !== "number" || body.expectedRevision !== revision(candidate.document.value) || text(body.reviewToken) !== candidate.token) throw new SaleCostRecoveryError("تغيرت الفاتورة أو مصدر التكلفة؛ حدّث قائمة المراجعة وأعد المحاولة", 409);
    if (candidate.revenue === null || (reportCostNumber(candidate.line.quantity) ?? 0) <= 0) throw new SaleCostRecoveryError("بيانات مبلغ أو كمية البيع غير مكتملة؛ لا يمكن اعتماد التكلفة آليًا", 409);
    if (action === "apply-suggested" && !candidate.resolution.source) throw new SaleCostRecoveryError("لا يوجد مصدر تكلفة تاريخي مؤكد لهذا السطر؛ لا يمكن تخمين التكلفة", 409);
    const cost = action === "confirm-zero" ? 0 : action === "set-reviewed-cost" ? reviewedCost! : candidate.resolution.source!.unitCost;
    const after = apply(db, candidate, cost, actor, action as "apply-suggested" | "confirm-zero" | "set-reviewed-cost", reason);
    const prior = setting(db) ?? {};
    saveSetting(db, { ...prior, version: SALE_COST_RECOVERY_VERSION, fingerprint: snapshot(db).fingerprint, completedAt: new Date().toISOString() });
    return { id: String(after.id), lineId: candidate.lineId, costAtSale: cost, revision: Number(after.revision ?? 0), action };
  });
}
