import { recoverHistoricalSaleCosts } from "./sale-cost-recovery.ts";
import { recoverHistoricalStockData } from "./stock-data-recovery.ts";
import type { SqliteSession as ClientSession, SqliteDatabase as Db, DbDocument as Document } from "./sqlite.ts";
import { ensureDatabaseSchema } from "./sqlite.ts";
import { rebuildDocumentSequenceCounters } from "./document-sequences.ts";
import { EJSON } from "bson";
import { resolvePartyType } from "../app/domain.ts";
import { backupBuildInfo, type BackupApplication, type BackupBuild } from "./build-info.ts";
import { ensurePerfumeSystemCategories } from "./perfume-system-categories.ts";
import { repairLegacyPayrollResume, validatePayrollSnapshot, type PayrollEmployee } from "./payroll.ts";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_COLLECTIONS = ["employees", "parties", "warehouses", "products", "productCategories", "expenseCategories", "documents", "stockMovements", "financialMovements", "paymentAccounts", "recurringExpenses", "accountTransfers", "counters", "auditEvents", "appSettings", "users", "importMappings"] as const;
// Backups are local, user-selected files. Do not impose an artificial size or record-count cap;
// validation below still enforces the accounting and reference invariants before restore.
type BackupCollection = typeof BACKUP_COLLECTIONS[number];
export type ContaBackup = { format: "conta-backup"; schemaVersion: 1; createdAt: string; appVersion: string; application?: BackupApplication; build?: BackupBuild; encoding: "json-v2"|"mongodb-extended-json-v2"; collections: Record<BackupCollection, Document[]>; counts: Record<BackupCollection, number> };

export async function createNativeBackup(db: Db): Promise<ContaBackup> {
  const pairs = await Promise.all(BACKUP_COLLECTIONS.map(async name => [name, await db.collection(name).find().toArray()] as const));
  const collections = Object.fromEntries(pairs) as unknown as ContaBackup["collections"];
  return { format: "conta-backup", schemaVersion: 1, createdAt: new Date().toISOString(), ...backupBuildInfo(), encoding: "json-v2", collections, counts: Object.fromEntries(pairs.map(([name, rows]) => [name, rows.length])) as ContaBackup["counts"] };
}
export function stringifyBackup(value: ContaBackup) { return value.encoding==="mongodb-extended-json-v2" ? EJSON.stringify(value,{relaxed:false}) : JSON.stringify(value); }
export function parseAndValidateBackup(input: string): ContaBackup {
  let value: unknown; try { const raw=JSON.parse(input) as Record<string,unknown>;value=raw.encoding==="mongodb-extended-json-v2"?EJSON.parse(input,{relaxed:true}):raw; } catch { throw new Error("ملف النسخة ليس JSON صالحًا"); }
  const b = value as Partial<ContaBackup>;
  if (b.format !== "conta-backup") throw new Error("هذا الملف ليس نسخة الكرنة");
  if (b.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error(Number(b.schemaVersion) > BACKUP_SCHEMA_VERSION ? "إصدار النسخة أحدث من هذا التطبيق" : "إصدار النسخة غير مدعوم");
  if (!b.collections || typeof b.collections !== "object" || Array.isArray(b.collections)) throw new Error("بنية collections غير صالحة");
  // Backups created before product categories existed have no productCategories collection.
  // Normalize them to an empty collection so old customer backups remain restorable.
  if (!Array.isArray(b.collections.productCategories)) b.collections.productCategories = [];
  // Import mappings were added after the first native-backup format shipped.
  // Old backups stay valid, while new restores replace stale mappings atomically.
  if (!Array.isArray(b.collections.importMappings)) b.collections.importMappings = [];
  if (b.collections.expenseCategories === undefined) b.collections.expenseCategories = [];
  if (b.collections.employees === undefined) b.collections.employees = [];
  const keys = Object.keys(b.collections);
  if (keys.some(k => !BACKUP_COLLECTIONS.includes(k as BackupCollection))) throw new Error("تحتوي النسخة على collection غير مسموح");
  for (const name of BACKUP_COLLECTIONS) if (!Array.isArray(b.collections[name])) throw new Error(`collection مفقود: ${name}`);
  const backup = b as ContaBackup;
  validateInvariants(repairBackupPayroll(backup)); return backup;
}
function repairBackupPayroll(backup: ContaBackup): ContaBackup {
  const { employees = [], documents, auditEvents } = backup.collections;
  const events = auditEvents.filter(event => ["payroll.employee.restore", "payroll.employee.update"].includes(event?.action));
  if (!events.length) return backup;
  const repaired = employees.map(employee => repairLegacyPayrollResume(employee as PayrollEmployee, documents, events));
  if (repaired.every((employee, index) => employee === employees[index])) return backup;
  return { ...backup, collections: { ...backup.collections, employees: repaired } };
}
const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
function unique(rows: Document[], field: string, label: string, optional = false) { const seen = new Set<string>(); for (const row of rows) { const v = row[field]; if (optional && !nonempty(v)) continue; if (!nonempty(v) || seen.has(v)) throw new Error(`${label} مكرر أو غير صالح`); seen.add(v); } return seen; }
export function validateInvariants(b: ContaBackup) {
  validatePayrollSnapshot(b.collections.employees??[], b.collections.documents, b.collections.financialMovements, b.collections.auditEvents);
  const products=unique(b.collections.products,"id","معرف المنتج"),categories=unique(b.collections.productCategories??[],"id","معرف الفئة"),warehouses=new Set(b.collections.warehouses.map(w=>String(w._id??w.id))),accounts=unique(b.collections.paymentAccounts,"id","معرف الحساب");
  const expenseCategories=unique(b.collections.expenseCategories??[],"id","معرف فئة المصروف");
  for(const category of b.collections.expenseCategories??[]){
    if(typeof category.name!=="string"||!category.name.trim()||category.name.length>80)throw new Error("اسم فئة المصروف غير صالح");
    if(category.kind!==undefined&&category.kind!=="recurring"&&category.kind!=="nonrecurring")throw new Error("نوع فئة المصروف غير صالح");
    if(category.isArchived!==undefined&&typeof category.isArchived!=="boolean")throw new Error("حالة فئة المصروف غير صالحة");
    if(category.revision!==undefined&&(!Number.isSafeInteger(category.revision)||category.revision<0))throw new Error("إصدار فئة المصروف غير صالح");
  }
  const accountKeys=new Set([...accounts,...b.collections.paymentAccounts.map(account=>String(account.code??"")).filter(Boolean)]);
  const parties=new Set(b.collections.parties.map(party=>String(party.id??party._id??"")).filter(Boolean));
  if(b.collections.warehouses.filter(w=>w.isSalesDefault===true).length!==1)throw new Error("يجب أن تحتوي النسخة على مخزن بيع افتراضي واحد");
  unique(b.collections.products,"sku","رمز المنتج");unique(b.collections.products,"barcode","باركود المنتج",true);unique(b.collections.documents,"id","معرف الفاتورة");unique(b.collections.documents,"number","رقم الفاتورة");
  for(const p of b.collections.products){if(p.categoryId&&!categories.has(String(p.categoryId)))throw new Error("منتج يشير إلى فئة غير موجودة");for(const key of Object.keys((p.stocks??{}) as object))if(!warehouses.has(key))throw new Error("مخزون يشير إلى مخزن غير موجود")}
  const employees=unique(b.collections.employees??[],"id","معرف العامل");
  for(const employee of b.collections.employees??[]){if(typeof employee.name!=="string"||!employee.name.trim()||!Number.isFinite(Number(employee.balance))||!Array.isArray(employee.agreements))throw new Error("بيانات العامل غير صالحة");}
  const accruals=new Set(b.collections.documents.filter(d=>d.kind==="employee-accrual").map(d=>String(d.id)));
  const saleSequences=new Set<string>(),openingParties=new Set<string>(),openingIds=new Set(b.collections.documents.filter(d=>d.kind==="party-opening").map(d=>String(d.id)));
  for(const d of b.collections.documents){
    if(d.kind==="party-opening"){
      const contribution=(d.partyOpeningDirection==="receivable"?1:-1)*d.partyOpeningAmount;
      if(!d.partyId||d.partyOpeningVersion!==1||!["receivable","payable"].includes(d.partyOpeningDirection)||!Number.isFinite(d.partyOpeningAmount)||d.partyOpeningAmount<=0||d.total!==d.partyOpeningAmount||d.partyOpeningContribution!==contribution||d.partyBalanceDelta!==contribution||d.paymentMethod||d.cashAmount!==0||d.paidTotal!==0||d.dueTotal!==0||(d.lines??[]).length)throw new Error("رصيد بداية الديون غير صالح");
      if(d.status==="posted"){if(openingParties.has(d.partyId))throw new Error("رصيد بداية مكرر للطرف نفسه");openingParties.add(d.partyId);}
    }
    if(["employee-accrual","employee-payment"].includes(d.kind)){if(!employees.has(String(d.employeeId))||!Number.isFinite(d.total)||d.total<=0)throw new Error("سند عامل غير صالح");if(d.kind==="employee-payment"&&(!Array.isArray(d.allocations)||d.allocations.some((a:Document)=>!accruals.has(String(a.accrualId))||!Number.isFinite(a.amount)||a.amount<=0)))throw new Error("توزيع صرف العامل غير صالح");}
    if(d.kind==="expense"&&d.expenseCategoryId&&!expenseCategories.has(String(d.expenseCategoryId)))throw new Error("مصروف يشير إلى فئة غير موجودة");
    if(d.warehouseId&&!warehouses.has(String(d.warehouseId)))throw new Error("فاتورة تشير إلى مخزن غير موجود");
    if(d.destinationWarehouseId&&!warehouses.has(String(d.destinationWarehouseId)))throw new Error("فاتورة تشير إلى مخزن وجهة غير موجود");
    if(d.partyId&&!parties.has(String(d.partyId)))throw new Error("فاتورة تشير إلى طرف غير موجود");
    if(d.paymentMethod&&d.paymentMethod!=="note"&&!accountKeys.has(String(d.paymentMethod)))throw new Error("فاتورة تشير إلى حساب غير موجود");
    if(d.kind==="sale"&&d.businessDate&&d.dailySequence!=null){const sequence=`${d.businessDate}:${d.dailySequence}`;if(saleSequences.has(sequence))throw new Error("تسلسل البيع اليومي مكرر");saleSequences.add(sequence)}
    for(const l of Array.isArray(d.lines)?d.lines:[])if(l.productId&&!products.has(String(l.productId)))throw new Error("فاتورة تشير إلى منتج غير موجود");
  }
  for(const movement of b.collections.stockMovements){if(openingIds.has(movement.documentId))throw new Error("رصيد بداية الديون لا يحرك المخزون");if(movement.productId&&!products.has(String(movement.productId)))throw new Error("حركة مخزون تشير إلى منتج غير موجود");if(movement.warehouseId&&!warehouses.has(String(movement.warehouseId)))throw new Error("حركة مخزون تشير إلى مخزن غير موجود")}
  for(const movement of b.collections.financialMovements){if(openingIds.has(movement.documentId))throw new Error("رصيد بداية الديون لا يحرك الصندوق");if(movement.paymentMethod&&!accountKeys.has(String(movement.paymentMethod)))throw new Error("حركة مالية تشير إلى حساب غير موجود");if(movement.partyId&&!parties.has(String(movement.partyId)))throw new Error("حركة مالية تشير إلى طرف غير موجود")}
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
  const repaired = repairBackupPayroll(backup);
  validateInvariants(repaired);
  for (const name of BACKUP_COLLECTIONS) {
    const collection = db.collection(name);
    await collection.deleteMany({}, { session });
    const rows = repaired.collections[name] ?? [];
    if (rows.length) await collection.insertMany(rows, { session, ordered: true });
  }
  if (repaired !== backup) {
    for (const [index, after] of repaired.collections.employees.entries()) {
      const before = backup.collections.employees[index];
      if (after === before) continue;
      await db.collection("auditEvents").insertOne({
        id: `payroll-audit-${crypto.randomUUID()}`, action: "payroll.employee.resume-repair", status: "committed",
        entityId: after.id, employeeId: after.id, createdAt: new Date().toISOString(), before, after,
      }, { session });
    }
  }
  await ensureLegacyCompatibility(db, session);
  // Old backups may contain uncategorized products. Normalize only after the
  // untouched backup has passed reference validation, inside the restore transaction.
  await ensurePerfumeSystemCategories(db, session);
  await rebuildCounters(db, session);
  recoverHistoricalStockData(db, { context: "native-restore" });
  recoverHistoricalSaleCosts(db, { context: "native-restore" });
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
