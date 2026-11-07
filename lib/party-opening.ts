import { randomUUID } from "node:crypto";
import { normalizePartyNet } from "../app/party-balance.ts";
import { resolvePartyType } from "../app/domain.ts";
import { reportCostNumber } from "./report-commerce.ts";
import type { DbDocument, SqliteDatabase, SqliteSession } from "./sqlite.ts";

export class PartyOpeningError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Input = Record<string, unknown>;
type Stored = { record_key: string; data_json: string; value: DbDocument };
type Direction = "receivable" | "payable";
const VERSION = 1;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

function note(value: unknown) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new PartyOpeningError("ملاحظة رصيد البداية غير صالحة");
  const result = text(value);
  if (result.length > 1000) throw new PartyOpeningError("ملاحظة رصيد البداية يجب ألا تتجاوز 1000 حرف");
  return result || null;
}

function values(body: Input) {
  const direction = text(body.direction);
  const amount = reportCostNumber(body.amount);
  if (direction !== "receivable" && direction !== "payable") throw new PartyOpeningError("اختر اتجاه رصيد البداية");
  if (amount === null || amount <= 0) throw new PartyOpeningError("مبلغ رصيد البداية يجب أن يكون رقمًا موجبًا صالحًا");
  return { direction: direction as Direction, amount, contribution: direction === "receivable" ? amount : -amount };
}

function openingDate(value: unknown, now: string) {
  if (value === undefined || value === null || value === "") return now;
  if (typeof value !== "string") throw new PartyOpeningError("تاريخ رصيد البداية غير صالح");
  const result = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00.000Z" : value;
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw new PartyOpeningError("تاريخ رصيد البداية غير صالح");
  return result;
}

function readStored(db: SqliteDatabase, table: "parties" | "documents", key: string) {
  const stored = db.native.prepare(`SELECT record_key,data_json FROM ${table} WHERE record_key=?`).get(key) as Omit<Stored, "value"> | undefined;
  return stored ? { ...stored, value: JSON.parse(stored.data_json) as DbDocument } : null;
}

async function party(db: SqliteDatabase, session: SqliteSession, partyId: unknown) {
  const id = text(partyId);
  const found = id ? await db.collection("parties").findOne({ id }, { session }) : null;
  const stored = found ? readStored(db, "parties", String(found._id ?? found.id)) : null;
  if (!stored || stored.value.id !== id) throw new PartyOpeningError("الطرف غير موجود", 404);
  return stored;
}

function balance(party: DbDocument) {
  const receivable = reportCostNumber(party.receivable === undefined ? 0 : party.receivable);
  const payable = reportCostNumber(party.payable === undefined ? 0 : party.payable);
  if (receivable === null || payable === null || !Number.isFinite(receivable - payable)) {
    throw new PartyOpeningError("رصيد الطرف المسجل غير صالح؛ راجع الحساب قبل تغيير رصيد البداية", 409);
  }
  return receivable - payable;
}

async function activeOpening(db: SqliteDatabase, session: SqliteSession, partyId: string) {
  const all = await db.collection("documents").find({ kind: "party-opening", partyId, status: "posted" }, { session }).toArray();
  if (all.length > 1) throw new PartyOpeningError("توجد أرصدة بداية متعددة لهذا الطرف؛ راجع المستندات قبل المتابعة", 409);
  return all[0] ?? null;
}

async function original(db: SqliteDatabase, session: SqliteSession, body: Input) {
  const documentId = text(body.documentId);
  const found = documentId ? await db.collection("documents").findOne({ id: documentId, kind: "party-opening", status: "posted" }, { session }) : null;
  const stored = found ? readStored(db, "documents", String(found._id ?? found.id)) : null;
  if (!stored) throw new PartyOpeningError("رصيد البداية غير موجود أو ملغى", 404);
  const document = stored.value;
  if (document.legacyKey || document.legacy || document.partyOpeningVersion !== VERSION ||
      !Number.isSafeInteger(document.revision) || document.revision < 0) {
    throw new PartyOpeningError("مستند رصيد البداية غير قابل للتعديل بهذه الطريقة", 409);
  }
  if (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== document.revision) {
    throw new PartyOpeningError("تغير رصيد البداية؛ حدّث الحساب وأعد المحاولة", 409);
  }
  const saved = values({ direction: document.partyOpeningDirection, amount: document.partyOpeningAmount });
  if (document.partyOpeningContribution !== saved.contribution || document.partyBalanceDelta !== saved.contribution ||
      document.total !== saved.amount || document.paymentMethod !== null || document.cashAmount !== 0 ||
      document.paidTotal !== 0 || document.dueTotal !== 0 || !Array.isArray(document.lines) || document.lines.length !== 0) {
    throw new PartyOpeningError("بيانات مستند رصيد البداية غير متسقة؛ راجع الحساب", 409);
  }
  const owner = await party(db, session, document.partyId);
  const active = await activeOpening(db, session, owner.value.id);
  if (active?.id !== documentId) throw new PartyOpeningError("تغير مستند رصيد البداية؛ حدّث الحساب وأعد المحاولة", 409);
  return { stored, party: owner, contribution: saved.contribution };
}

function save(db: SqliteDatabase, table: "parties" | "documents", before: Stored, after: DbDocument) {
  const updated = db.native.prepare(`UPDATE ${table} SET data_json=? WHERE record_key=? AND data_json=?`)
    .run(JSON.stringify(after), before.record_key, before.data_json);
  if (updated.changes !== 1) throw new PartyOpeningError("تغير الحساب أثناء العملية؛ حدّث الصفحة وأعد المحاولة", 409);
}

function applyContribution(db: SqliteDatabase, owner: Stored, delta: number, now: string) {
  const before = balance(owner.value), after = before + delta;
  if (!Number.isFinite(delta) || !Number.isFinite(after)) throw new PartyOpeningError("نتيجة رصيد البداية غير صالحة");
  const result = delta === 0 ? structuredClone(owner.value) : {
    ...owner.value, ...normalizePartyNet(after), lastMovementAt: now,
    ...(owner.value.isArchived === true && after !== 0 ? { isArchived: false, archivedAt: null } : {}),
  };
  if (delta !== 0) save(db, "parties", owner, result);
  return { before, delta, after, party: result };
}

async function audit(db: SqliteDatabase, session: SqliteSession, action: string, beforeDocument: DbDocument | null,
  afterDocument: DbDocument, beforeParty: DbDocument, afterParty: DbDocument, appliedDelta: number, reason: string | null) {
  const id = "party-opening-audit-" + randomUUID();
  await db.collection("auditEvents").insertOne({
    id, action, entityId: afterDocument.id, partyId: afterDocument.partyId, version: VERSION,
    status: "committed", createdAt: new Date().toISOString(), reason,
    beforeDocument, afterDocument, beforeParty, afterParty, appliedDelta,
  }, { session });
}

async function atomic<T>(db: SqliteDatabase, work: () => Promise<T>) {
  if (!db.native.inTransaction) throw new PartyOpeningError("يجب حفظ رصيد البداية ضمن عملية الحساب", 500);
  const point = "party_opening_" + randomUUID().replaceAll("-", "");
  db.native.exec(`SAVEPOINT ${point}`);
  try {
    const result = await work();
    db.native.exec(`RELEASE SAVEPOINT ${point}`);
    return result;
  } catch (error) {
    db.native.exec(`ROLLBACK TO SAVEPOINT ${point}`);
    db.native.exec(`RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}

/** Called inside the command transaction, including after full-form party creation. */
export function postPartyOpening(db: SqliteDatabase, session: SqliteSession, body: Input) {
  return atomic(db, async () => {
    const input = values(body), detail = note(body.note), now = new Date().toISOString();
    const occurredAt = openingDate(body.occurredAt, now), owner = await party(db, session, body.partyId);
    if (owner.value.isArchived === true) throw new PartyOpeningError("استعد الطرف المؤرشف قبل إضافة رصيد بداية", 409);
    if (await activeOpening(db, session, owner.value.id)) throw new PartyOpeningError("رصيد البداية موجود؛ عدّل مستنده الحالي بدل إضافته مرة أخرى", 409);
    const effect = applyContribution(db, owner, input.contribution, now);
    const document = {
      id: "party-opening-" + randomUUID(), number: "POB-" + Date.now() + "-" + randomUUID().slice(0, 8),
      kind: "party-opening", status: "posted", revision: 0, occurredAt, createdAt: now,
      partyId: owner.value.id, partyName: owner.value.name, partyType: resolvePartyType(owner.value),
      warehouseId: null, warehouseName: null, destinationWarehouseId: null, destinationWarehouseName: null,
      parentDocumentId: null, paymentMethod: null, title: "رصيد بداية الحساب", note: detail,
      total: input.amount, paidTotal: 0, dueTotal: 0, cashAmount: 0, lines: [],
      partyOpeningVersion: VERSION, partyOpeningDirection: input.direction, partyOpeningAmount: input.amount,
      partyOpeningContribution: input.contribution, partyBalanceDelta: input.contribution,
      partyOpeningBalanceBefore: effect.before, partyOpeningAppliedDelta: effect.delta, partyOpeningBalanceAfter: effect.after,
    };
    await db.collection("documents").insertOne(document, { session });
    await audit(db, session, "party-opening.post", null, document, owner.value, effect.party, effect.delta, detail);
    return document.id;
  });
}

export function updatePartyOpening(db: SqliteDatabase, session: SqliteSession, body: Input) {
  return atomic(db, async () => {
    const input = values(body), reason = note(body.reason), now = new Date().toISOString();
    const current = await original(db, session, body), before = current.stored.value;
    const effect = applyContribution(db, current.party, input.contribution - current.contribution, now);
    const after = {
      ...before, partyName: current.party.value.name, total: input.amount,
      note: body.note === undefined ? before.note : note(body.note),
      partyOpeningDirection: input.direction, partyOpeningAmount: input.amount,
      partyOpeningContribution: input.contribution, partyBalanceDelta: input.contribution,
      partyOpeningBalanceBefore: effect.before, partyOpeningAppliedDelta: effect.delta, partyOpeningBalanceAfter: effect.after,
      updatedAt: now, revision: before.revision + 1,
    };
    save(db, "documents", current.stored, after);
    await audit(db, session, "party-opening.update", before, after, current.party.value, effect.party, effect.delta, reason);
    return String(before.id);
  });
}

export function voidPartyOpening(db: SqliteDatabase, session: SqliteSession, body: Input) {
  return atomic(db, async () => {
    const reason = note(body.reason), now = new Date().toISOString();
    const current = await original(db, session, body), before = current.stored.value;
    const effect = applyContribution(db, current.party, -current.contribution, now);
    const after = {
      ...before, status: "voided", voidedAt: now, updatedAt: now, revision: before.revision + 1,
      partyOpeningBalanceBefore: effect.before, partyOpeningAppliedDelta: effect.delta, partyOpeningBalanceAfter: effect.after,
    };
    save(db, "documents", current.stored, after);
    await audit(db, session, "party-opening.void", before, after, current.party.value, effect.party, effect.delta, reason);
    return String(before.id);
  });
}
