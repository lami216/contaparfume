import type { SqliteSession as ClientSession, SqliteDatabase as Db } from "./sqlite.ts";
export const SEQUENCED_DOCUMENT_KINDS = ["sale", "purchase", "expense"] as const;
export type SequencedDocumentKind = typeof SEQUENCED_DOCUMENT_KINDS[number];
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
}
export const rebuildDocumentSequenceCounters=backfillDocumentSequences;
export function displayDocumentNumber(document:Record<string,unknown>){return SEQUENCED_DOCUMENT_KINDS.includes(document.kind as SequencedDocumentKind)&&Number.isSafeInteger(Number(document.sequence))&&Number(document.sequence)>0?String(document.sequence):String(document.number??"—")}
