import type { SqliteSession as ClientSession, SqliteDatabase as Db, DbDocument as Document } from "./sqlite.ts";
import { ensureDatabaseSchema } from "./sqlite.ts";
import { rebuildDocumentSequenceCounters } from "./document-sequences.ts";
import { EJSON } from "bson";
import { resolvePartyType } from "../app/domain.ts";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_COLLECTIONS = ["parties", "warehouses", "products", "productCategories", "documents", "stockMovements", "financialMovements", "paymentAccounts", "recurringExpenses", "accountTransfers", "counters", "auditEvents", "appSettings", "users", "importMappings"] as const;
// Backups are local, user-selected files. Do not impose an artificial size or record-count cap;
// validation below still enforces the accounting and reference invariants before restore.
type BackupCollection = typeof BACKUP_COLLECTIONS[number];
export type ContaBackup = { format: "conta-backup"; schemaVersion: 1; createdAt: string; appVersion: string; encoding: "json-v2"|"mongodb-extended-json-v2"; collections: Record<BackupCollection, Document[]>; counts: Record<BackupCollection, number> };

export async function createNativeBackup(db: Db): Promise<ContaBackup> {
  const pairs = await Promise.all(BACKUP_COLLECTIONS.map(async name => [name, await db.collection(name).find().toArray()] as const));
  const collections = Object.fromEntries(pairs) as unknown as ContaBackup["collections"];
  return { format: "conta-backup", schemaVersion: 1, createdAt: new Date().toISOString(), appVersion: process.env.npm_package_version ?? "0.1.0", encoding: "json-v2", collections, counts: Object.fromEntries(pairs.map(([name, rows]) => [name, rows.length])) as ContaBackup["counts"] };
}
export function stringifyBackup(value: ContaBackup) { return value.encoding==="mongodb-extended-json-v2" ? EJSON.stringify(value,{relaxed:false}) : JSON.stringify(value); }
export function parseAndValidateBackup(input: string): ContaBackup {
  let value: unknown; try { const raw=JSON.parse(input) as Record<string,unknown>;value=raw.encoding==="mongodb-extended-json-v2"?EJSON.parse(input,{relaxed:true}):raw; } catch { throw new Error("ملف النسخة ليس JSON صالحًا"); }
  const b = value as Partial<ContaBackup>;
  if (b.format !== "conta-backup") throw new Error("هذا الملف ليس نسخة الكرنه");
  if (b.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error(Number(b.schemaVersion) > BACKUP_SCHEMA_VERSION ? "إصدار النسخة أحدث من هذا التطبيق" : "إصدار النسخة غير مدعوم");
  if (!b.collections || typeof b.collections !== "object" || Array.isArray(b.collections)) throw new Error("بنية collections غير صالحة");
  // Backups created before product categories existed have no productCategories collection.
  // Normalize them to an empty collection so old customer backups remain restorable.
  if (!Array.isArray(b.collections.productCategories)) b.collections.productCategories = [];
  // Import mappings were added after the first native-backup format shipped.
  // Old backups stay valid, while new restores replace stale mappings atomically.
  if (!Array.isArray(b.collections.importMappings)) b.collections.importMappings = [];
  const keys = Object.keys(b.collections);
  if (keys.some(k => !BACKUP_COLLECTIONS.includes(k as BackupCollection))) throw new Error("تحتوي النسخة على collection غير مسموح");
  for (const name of BACKUP_COLLECTIONS) if (!Array.isArray(b.collections[name])) throw new Error(`collection مفقود: ${name}`);
  validateInvariants(b as ContaBackup); return b as ContaBackup;
}
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
function unique(rows: Document[], field: string, label: string, optional = false) { const seen = new Set<string>(); for (const row of rows) { const v = row[field]; if (optional && !nonempty(v)) continue; if (!nonempty(v) || seen.has(v)) throw new Error(`${label} مكرر أو غير صالح`); seen.add(v); } return seen; }
export function validateInvariants(b: ContaBackup) {
  const products=unique(b.collections.products,"id","معرف المنتج"),categories=unique(b.collections.productCategories??[],"id","معرف الفئة"),warehouses=new Set(b.collections.warehouses.map(w=>String(w._id??w.id))),accounts=unique(b.collections.paymentAccounts,"id","معرف الحساب");
  const accountKeys=new Set([...accounts,...b.collections.paymentAccounts.map(account=>String(account.code??"")).filter(Boolean)]);
  const parties=new Set(b.collections.parties.map(party=>String(party.id??party._id??"")).filter(Boolean));
  if(b.collections.warehouses.filter(w=>w.isSalesDefault===true).length!==1)throw new Error("يجب أن تحتوي النسخة على مخزن بيع افتراضي واحد");
  unique(b.collections.products,"sku","رمز المنتج");unique(b.collections.products,"barcode","باركود المنتج",true);unique(b.collections.documents,"id","معرف الفاتورة");unique(b.collections.documents,"number","رقم الفاتورة");
  for(const p of b.collections.products){if(p.categoryId&&!categories.has(String(p.categoryId)))throw new Error("منتج يشير إلى فئة غير موجودة");for(const key of Object.keys((p.stocks??{}) as object))if(!warehouses.has(key))throw new Error("مخزون يشير إلى مخزن غير موجود")}
  const saleSequences=new Set<string>();
  for(const d of b.collections.documents){
    if(d.warehouseId&&!warehouses.has(String(d.warehouseId)))throw new Error("فاتورة تشير إلى مخزن غير موجود");
    if(d.destinationWarehouseId&&!warehouses.has(String(d.destinationWarehouseId)))throw new Error("فاتورة تشير إلى مخزن وجهة غير موجود");
    if(d.partyId&&!parties.has(String(d.partyId)))throw new Error("فاتورة تشير إلى طرف غير موجود");
    if(d.paymentMethod&&d.paymentMethod!=="note"&&!accountKeys.has(String(d.paymentMethod)))throw new Error("فاتورة تشير إلى حساب غير موجود");
    if(d.kind==="sale"&&d.businessDate&&d.dailySequence!=null){const sequence=`${d.businessDate}:${d.dailySequence}`;if(saleSequences.has(sequence))throw new Error("تسلسل البيع اليومي مكرر");saleSequences.add(sequence)}
    for(const l of Array.isArray(d.lines)?d.lines:[])if(l.productId&&!products.has(String(l.productId)))throw new Error("فاتورة تشير إلى منتج غير موجود");
  }
  for(const movement of b.collections.stockMovements){if(movement.productId&&!products.has(String(movement.productId)))throw new Error("حركة مخزون تشير إلى منتج غير موجود");if(movement.warehouseId&&!warehouses.has(String(movement.warehouseId)))throw new Error("حركة مخزون تشير إلى مخزن غير موجود")}
  for(const movement of b.collections.financialMovements){if(movement.paymentMethod&&!accountKeys.has(String(movement.paymentMethod)))throw new Error("حركة مالية تشير إلى حساب غير موجود");if(movement.partyId&&!parties.has(String(movement.partyId)))throw new Error("حركة مالية تشير إلى طرف غير موجود")}
  for(const transfer of b.collections.accountTransfers){if(transfer.fromAccountId&&!accountKeys.has(String(transfer.fromAccountId)))throw new Error("تحويل يشير إلى حساب مصدر غير موجود");if(transfer.toAccountId&&!accountKeys.has(String(transfer.toAccountId)))throw new Error("تحويل يشير إلى حساب وجهة غير موجود")}
  const mappingKeys=new Set<string>(),mappingTargets:Record<string,Set<string>>={products,parties,paymentAccounts:accounts,warehouses};
  for(const mapping of b.collections.importMappings??[]){
    const sourceKey=`${String(mapping.sourceType??"")}:${String(mapping.sourceEntityType??"")}:${String(mapping.sourceKey??"")}`;
    if(mappingKeys.has(sourceKey))throw new Error("خريطة استيراد مكررة");mappingKeys.add(sourceKey);
    const type=String(mapping.targetEntityType??""),targetId=String(mapping.targetId??""),targets=mappingTargets[type];
    if(targets&&targetId&&!targets.has(targetId))throw new Error("خريطة استيراد تشير إلى سجل غير موجود");
  }
}
export async function restoreNativeBackup(db: Db, backup: ContaBackup, session: ClientSession) {
  validateInvariants(backup);
  for (const name of BACKUP_COLLECTIONS) {
    const collection = db.collection(name);
    await collection.deleteMany({}, { session });
    const rows = backup.collections[name] ?? [];
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
