import type { SqliteSession as ClientSession, SqliteDatabase as Db, DbDocument as Document } from "./sqlite.ts";
import { ensureDatabaseSchema } from "./sqlite.ts";
import { rebuildDocumentSequenceCounters } from "./document-sequences.ts";
import { EJSON } from "bson";
import { resolvePartyType } from "../app/domain.ts";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_COLLECTIONS = ["parties", "warehouses", "products", "documents", "stockMovements", "financialMovements", "paymentAccounts", "recurringExpenses", "accountTransfers", "counters", "auditEvents", "appSettings", "users"] as const;
export const MAX_BACKUP_ITEMS = 500_000;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
type BackupCollection = typeof BACKUP_COLLECTIONS[number];
export type ContaBackup = { format: "conta-backup"; schemaVersion: 1; createdAt: string; appVersion: string; encoding: "json-v2"|"mongodb-extended-json-v2"; collections: Record<BackupCollection, Document[]>; counts: Record<BackupCollection, number> };

export async function createNativeBackup(db: Db): Promise<ContaBackup> {
  const pairs = await Promise.all(BACKUP_COLLECTIONS.map(async name => [name, await db.collection(name).find().toArray()] as const));
  const collections = Object.fromEntries(pairs) as unknown as ContaBackup["collections"];
  return { format: "conta-backup", schemaVersion: 1, createdAt: new Date().toISOString(), appVersion: process.env.npm_package_version ?? "0.1.0", encoding: "json-v2", collections, counts: Object.fromEntries(pairs.map(([name, rows]) => [name, rows.length])) as ContaBackup["counts"] };
}
export function stringifyBackup(value: ContaBackup) { return value.encoding==="mongodb-extended-json-v2" ? EJSON.stringify(value,{relaxed:false}) : JSON.stringify(value); }
export function parseAndValidateBackup(input: string): ContaBackup {
  if (Buffer.byteLength(input) > MAX_BACKUP_BYTES) throw new Error("ملف النسخة أكبر من الحد المسموح");
  let value: unknown; try { const raw=JSON.parse(input) as Record<string,unknown>;value=raw.encoding==="mongodb-extended-json-v2"?EJSON.parse(input,{relaxed:true}):raw; } catch { throw new Error("ملف النسخة ليس JSON صالحًا"); }
  const b = value as Partial<ContaBackup>;
  if (b.format !== "conta-backup") throw new Error("هذا الملف ليس نسخة الكرنه");
  if (b.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error(Number(b.schemaVersion) > BACKUP_SCHEMA_VERSION ? "إصدار النسخة أحدث من هذا التطبيق" : "إصدار النسخة غير مدعوم");
  if (!b.collections || typeof b.collections !== "object" || Array.isArray(b.collections)) throw new Error("بنية collections غير صالحة");
  const keys = Object.keys(b.collections);
  if (keys.some(k => !BACKUP_COLLECTIONS.includes(k as BackupCollection))) throw new Error("تحتوي النسخة على collection غير مسموح");
  for (const name of BACKUP_COLLECTIONS) if (!Array.isArray(b.collections[name])) throw new Error(`collection مفقود: ${name}`);
  const total = BACKUP_COLLECTIONS.reduce((n, k) => n + b.collections![k].length, 0); if (total > MAX_BACKUP_ITEMS) throw new Error("عدد السجلات أكبر من الحد المسموح");
  validateInvariants(b as ContaBackup); return b as ContaBackup;
}
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
function unique(rows: Document[], field: string, label: string, optional = false) { const seen = new Set<string>(); for (const row of rows) { const v = row[field]; if (optional && !nonempty(v)) continue; if (!nonempty(v) || seen.has(v)) throw new Error(`${label} مكرر أو غير صالح`); seen.add(v); } return seen; }
export function validateInvariants(b: ContaBackup) {
  const products = unique(b.collections.products, "id", "معرف المنتج"), warehouses = new Set(b.collections.warehouses.map(w => String(w._id ?? w.id))), accounts = unique(b.collections.paymentAccounts, "id", "معرف الحساب");
  if (b.collections.warehouses.filter(w => w.isSalesDefault === true).length !== 1) throw new Error("يجب أن تحتوي النسخة على مخزن بيع افتراضي واحد");
  unique(b.collections.products, "sku", "رمز المنتج"); unique(b.collections.products, "barcode", "باركود المنتج", true); unique(b.collections.documents, "id", "معرف الفاتورة"); unique(b.collections.documents, "number", "رقم الفاتورة");
  for (const p of b.collections.products) for (const key of Object.keys((p.stocks ?? {}) as object)) if (!warehouses.has(key)) throw new Error("مخزون يشير إلى مخزن غير موجود");
  const saleSequences = new Set<string>();
  for (const d of b.collections.documents) { if (d.warehouseId && !warehouses.has(String(d.warehouseId))) throw new Error("فاتورة تشير إلى مخزن غير موجود"); if (d.paymentMethod && d.paymentMethod !== "note" && !accounts.has(String(d.paymentMethod)) && !b.collections.paymentAccounts.some(a => a.code === d.paymentMethod)) throw new Error("فاتورة تشير إلى حساب غير موجود"); if (d.kind === "sale" && d.businessDate && d.dailySequence != null) { const sequence = `${d.businessDate}:${d.dailySequence}`; if (saleSequences.has(sequence)) throw new Error("تسلسل البيع اليومي مكرر"); saleSequences.add(sequence); } for (const l of Array.isArray(d.lines) ? d.lines : []) if (l.productId && !products.has(String(l.productId))) throw new Error("فاتورة تشير إلى منتج غير موجود"); }
}
export async function restoreNativeBackup(db: Db, backup: ContaBackup, session: ClientSession) {
  validateInvariants(backup);
  for (const name of BACKUP_COLLECTIONS) {
    const collection = db.collection(name);
    await collection.deleteMany({}, { session });
    const rows = backup.collections[name];
    if (rows.length) await collection.insertMany(rows, { session, ordered: true });
  }
  await ensureLegacyCompatibility(db, session);
  await rebuildCounters(db, session);
  validateInvariants(await createNativeBackup(db));
}
export async function ensureLegacyCompatibility(db: Db, session?: ClientSession) {
  const parties=await db.collection("parties").find({}, {session}).toArray();
  for(const party of parties)if(!party.partyType)await db.collection("parties").updateOne({_id:party._id},{$set:{partyType:resolvePartyType(party)}},{session});
  const sales=await db.collection("documents").find({kind:"sale"},{session}).sort({businessDate:1,occurredAt:1,id:1}).toArray(),used=new Map<string,Set<number>>();
  for(const sale of sales)if(sale.businessDate&&Number.isSafeInteger(Number(sale.dailySequence))&&Number(sale.dailySequence)>0){const day=String(sale.businessDate),values=used.get(day)??new Set<number>();values.add(Number(sale.dailySequence));used.set(day,values)}
  for(const sale of sales)if(sale.businessDate&&!(Number.isSafeInteger(Number(sale.dailySequence))&&Number(sale.dailySequence)>0)){const day=String(sale.businessDate),values=used.get(day)??new Set<number>();let sequence=1;while(values.has(sequence))sequence++;values.add(sequence);used.set(day,values);await db.collection("documents").updateOne({_id:sale._id},{$set:{dailySequence:sequence}},{session})}
}
export async function rebuildCounters(db: Db, session?: ClientSession) { const products = await db.collection("products").find({}, { session, projection: { sku: 1 } }).toArray(); const max = products.reduce((n,p) => /^\d{1,9}$/.test(String(p.sku)) ? Math.max(n, Number(p.sku)) : n, 0); await db.collection<{_id:string;value:number;updatedAt?:Date}>("counters").updateOne({ _id: "productSequence" }, { $max: { value: max }, $set: { updatedAt: new Date() } }, { upsert: true, session }); await rebuildDocumentSequenceCounters(db); }
export async function finishRestore(db: Db) { await ensureDatabaseSchema(db); }
