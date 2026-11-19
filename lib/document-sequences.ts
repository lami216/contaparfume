import type { SqliteSession as ClientSession, SqliteDatabase as Db } from "./sqlite.ts";
import { isStockSettlementDocument, validSettlementSequence } from "../app/stock-settlement.ts";
export const SEQUENCED_DOCUMENT_KINDS = ["sale", "purchase", "expense", "decant-sale", "decant-purchase"] as const;
export type SequencedDocumentKind = typeof SEQUENCED_DOCUMENT_KINDS[number];
export const STOCK_SETTLEMENT_COUNTER_ID = "documentSequence:stock-settlement";
const counterId = (kind: SequencedDocumentKind) => `documentSequence:${kind}`;
export async function nextDocumentSequence(db: Db, kind: SequencedDocumentKind, session?: ClientSession) {
  const counter = await db.collection<{ _id: string; value: number }>("counters").findOneAndUpdate({ _id: counterId(kind) }, { $inc: { value: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true, returnDocument: "after", session });
  if (!counter) throw new Error("تعذر توليد رقم المستند");
  return counter.value;
}
/** Read the next informational number without reserving or mutating it. */
export async function peekNextDocumentSequence(db: Db, kind: SequencedDocumentKind) {
  const counter = await db.collection<{ _id: string; value: number }>("counters").findOne({ _id: counterId(kind) });
  return Number(counter?.value ?? 0) + 1;
}
/** Allocate the lowest free positive numbers without assuming that existing rows are contiguous. */
export function allocateAvailableSequences(usedValues: Iterable<number>, count: number) {
  const used = new Set([...usedValues].filter(value => Number.isSafeInteger(value) && value > 0));
  const allocated: number[] = [];
  let candidate = 1;
  while (allocated.length < count) {
    while (used.has(candidate)) candidate++;
    allocated.push(candidate);
    used.add(candidate++);
  }
  return allocated;
}
const preferred = (value: unknown) => { const raw=String(value??"").trim(); if(!/^\d+$/.test(raw))return null;const n=Number(raw);return Number.isSafeInteger(n)&&n>0?n:null; };
/** Additive/idempotent compatibility migration used by startup, restore and import. */
export async function backfillDocumentSequences(db: Db) {
  for (const kind of SEQUENCED_DOCUMENT_KINDS) {
    const documents=await db.collection("documents").find({kind}).sort({occurredAt:1,id:1}).toArray();
    const used=new Set(documents.map(d=>Number(d.sequence)).filter(n=>Number.isSafeInteger(n)&&n>0));
    const missing=documents.filter(d=>!("sequence" in d)), counts=new Map<number,number>();
    for(const d of missing){const n=preferred(d.legacyBillCode);if(n)counts.set(n,(counts.get(n)??0)+1)}
    let next=used.size?Math.max(...used):0;
    const operations=missing.map(d=>{const candidate=preferred(d.legacyBillCode);let sequence:number;if(candidate&&counts.get(candidate)===1&&!used.has(candidate))sequence=candidate;else{do sequence=++next;while(used.has(sequence))}used.add(sequence);next=Math.max(next,sequence);return{updateOne:{filter:{_id:d._id,sequence:{$exists:false}},update:{$set:{sequence}}}}});
    if(operations.length)await db.collection("documents").bulkWrite(operations);
    await db.collection<{_id:string;value:number;updatedAt?:Date;createdAt?:Date}>("counters").updateOne({_id:counterId(kind)},{$max:{value:used.size?Math.max(...used):0},$set:{updatedAt:new Date()},$setOnInsert:{createdAt:new Date()}},{upsert:true});
  }
  await backfillStockSettlementSequences(db);
}
export const rebuildDocumentSequenceCounters=backfillDocumentSequences;
export function displayDocumentNumber(document:Record<string,unknown>){return isStockSettlementDocument(document)&&validSettlementSequence(document.settlementSequence)?String(document.settlementSequence):SEQUENCED_DOCUMENT_KINDS.includes(document.kind as SequencedDocumentKind)&&Number.isSafeInteger(Number(document.sequence))&&Number(document.sequence)>0?String(document.sequence):String(document.number??"—")}
/** Display projection only: stored stock movement references remain intact. */
export function displayStockMovementDocumentNumber(movement:Record<string,unknown>, document?:Record<string,unknown>) {
  return document&&isStockSettlementDocument(document)&&validSettlementSequence(document.settlementSequence)
    ? String(document.settlementSequence) : String(movement.documentNumber??document?.number??"");
}

/** Preserve every valid first assignment (including voided revisions), and put
 * missing/invalid/duplicate metadata above the saved high-water mark. Original
 * reference numbers and invoice sequences are never rewritten. */
export async function backfillStockSettlementSequences(db: Db, session?: ClientSession) {
  const normalize = async (currentSession: ClientSession | undefined) => {
    const documents = (await db.collection("documents").find({ kind: "adjustment" }, { session: currentSession }).toArray()).filter(isStockSettlementDocument);
    const counter = await db.collection("counters").findOne({ _id: STOCK_SETTLEMENT_COUNTER_ID }, { session: currentSession });
    const saved = counter?.value;
    if (saved !== undefined && (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0)) throw new Error("عداد التسويات غير صالح");
    let maximum = typeof saved === "number" ? saved : 0;
    const used = new Set<number>(), missing: typeof documents = [];
    for (const document of documents) {
      const sequence = document.settlementSequence;
      if (validSettlementSequence(sequence) && !used.has(sequence)) { used.add(sequence); maximum = Math.max(maximum, sequence); }
      else missing.push(document);
    }
    for (const document of missing) {
      if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error("تعذر تخصيص رقم تسوية صالح");
      const sequence = ++maximum;
      const changed = await db.collection("documents").updateOne(
        { _id: document._id, settlementSequence: Object.hasOwn(document, "settlementSequence") ? document.settlementSequence : { $exists: false } },
        { $set: { settlementSequence: sequence } }, { session: currentSession },
      );
      if (!changed.matchedCount) throw new Error("تغير ترقيم التسويات أثناء التهيئة؛ أعد المحاولة");
    }
    if (documents.length && (!counter || saved !== maximum)) await db.collection("counters").updateOne(
      { _id: STOCK_SETTLEMENT_COUNTER_ID }, { $set: { value: maximum, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true, session: currentSession },
    );
    return { updated: missing.length, maximum };
  };
  return db.native.inTransaction ? normalize(session) : db.transaction(normalize);
}

const ready = new WeakMap<Db, Promise<unknown>>();
/** Once per database process for authenticated reads. Restore/import call the
 * uncached normalizer above after replacing rows, so an old backup is never
 * hidden by a process marker. An outer transaction must not cache rolled-back
 * work as ready. Healthy reads perform no writes or repeated history replay. */
export async function ensureStockSettlementNumberingReady(db: Db, session?: ClientSession) {
  if (db.native.inTransaction) return backfillStockSettlementSequences(db, session);
  let pending = ready.get(db);
  if (!pending) {
    pending = backfillStockSettlementSequences(db, session);
    ready.set(db, pending);
    try { await pending; } catch (error) { ready.delete(db); throw error; }
  }
  return pending;
}

/** Allocate inside the caller's financial transaction; rollback also rolls back
 * the reservation. Committed canceled/replaced documents keep their numbers. */
export async function nextStockSettlementSequence(db: Db, session?: ClientSession) {
  const allocate = async (currentSession: ClientSession | undefined) => {
    const normalized = await backfillStockSettlementSequences(db, currentSession);
    if (normalized.maximum >= Number.MAX_SAFE_INTEGER) throw new Error("تعذر تخصيص رقم تسوية صالح");
    const counter = await db.collection("counters").findOneAndUpdate(
      { _id: STOCK_SETTLEMENT_COUNTER_ID }, { $inc: { value: 1 }, $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: "after", session: currentSession },
    );
    if (!counter || !validSettlementSequence(counter.value)) throw new Error("تعذر تخصيص رقم تسوية صالح");
    return counter.value;
  };
  return db.native.inTransaction ? allocate(session) : db.transaction(allocate);
}
