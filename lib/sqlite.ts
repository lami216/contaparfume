/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type DbDocument = Record<string, any>;
export type SqliteSession = Record<string, never>;

const tableNames: Record<string, string> = {
  products: "products", productCategories: "product_categories", warehouses: "warehouses", parties: "parties", paymentAccounts: "payment_accounts",
  documents: "documents", stockMovements: "stock_movements", financialMovements: "financial_movements",
  recurringExpenses: "recurring_expenses", accountTransfers: "account_transfers", appSettings: "app_settings",
  auditEvents: "audit_events", counters: "counters", commandReceipts: "command_receipts", users: "users",
  importRuns: "import_runs", importMappings: "import_mappings", importSafetyBackups: "import_safety_backups",
  restoreSnapshots: "restore_snapshots", legacyImportRuns: "legacy_import_runs",
};
let connection: Database.Database | undefined;
let database: SqliteDatabase | undefined;

const encode = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item);
const decode = (value: string) => JSON.parse(value) as DbDocument;
const get = (object: any, path: string) => path.split(".").reduce((value, key) => Array.isArray(value) ? value.map(item => item?.[key]) : value?.[key], object);
const scalar = (value: any) => Array.isArray(value) ? value.flat(Infinity) : [value];
const equal = (a: any, b: any) => a instanceof Date ? a.toISOString() === b : b instanceof Date ? b.toISOString() === a : a === b;
function matchesValue(value: any, expected: any): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
    return Object.entries(expected).every(([op, wanted]) => {
      const values = scalar(value);
      if (op === "$in") return values.some(v => (wanted as any[]).some(x => equal(v, x)));
      if (op === "$ne") return values.every(v => !equal(v, wanted));
      if (op === "$gt") return values.some(v => v > wanted!); if (op === "$gte") return values.some(v => v >= wanted!);
      if (op === "$lt") return values.some(v => v < wanted!); if (op === "$lte") return values.some(v => v <= wanted!);
      if (op === "$exists") return (value !== undefined) === wanted;
      if (op === "$type") return values.some(v => wanted === "number" ? typeof v === "number" : wanted === "string" ? typeof v === "string" : true);
      if (op === "$regex") { const flags = String((expected as any).$options ?? ""); return values.some(v => new RegExp(wanted as any, flags).test(String(v ?? ""))); }
      if (op === "$options") return true;
      return matchesValue(get(value, op), wanted);
    });
  }
  return scalar(value).some(v => equal(v, expected));
}
function matches(row: DbDocument, query: DbDocument = {}): boolean {
  return Object.entries(query).every(([key, expected]) => key === "$or" ? (expected as DbDocument[]).some(q => matches(row, q)) : key === "$and" ? (expected as DbDocument[]).every(q => matches(row, q)) : matchesValue(get(row, key), expected));
}

type SqlCandidate = { sql: string; params: Array<string | number | null>; complete: boolean };
const sqlScalarFields = new Set([
  "_id","id","key","kind","status","partyId","partyType","paymentMethod","type","direction","productId","categoryId",
  "documentId","parentDocumentId","warehouseId","recurringId","code","legacyKey","usernameNormalized","sourceType",
  "sourceEntityType","sourceKey","businessDate","isArchived","isReversal","isActive","isSalesDefault","occurrenceKey",
  "expiryDate","receivable","payable",
]);
const sqlRangeFields = new Set(["occurredAt","createdAt","updatedAt","expiresAt","archivedAt","businessDate","expiryDate","receivable","payable"]);
const sqlFieldName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sqlPrimitive = (value: unknown): value is string | number | boolean | null => value === null || ["string","number","boolean"].includes(typeof value);
const sqlValue = (value: string | number | boolean | null): string | number | null => typeof value === "boolean" ? (value ? 1 : 0) : value;
const jsonPath = (field:string) => `$.${field}`;
const jsonExpr = (field:string) => `json_extract(data_json,'${jsonPath(field)}')`;
const jsonTypeExpr = (field:string) => `json_type(data_json,'${jsonPath(field)}')`;
function sqlFieldCandidate(field:string, expected:unknown):SqlCandidate {
  if(field==="lines.productId"){
    const lineExpr="json_extract(line.value,'$.productId')",lineType="json_type(line.value,'$.productId')";
    if(sqlPrimitive(expected)){if(expected===null)return{sql:`EXISTS (SELECT 1 FROM json_each(data_json,'$.lines') line WHERE ${lineType}='null')`,params:[],complete:true};return{sql:`EXISTS (SELECT 1 FROM json_each(data_json,'$.lines') line WHERE ${lineExpr}=?)`,params:[sqlValue(expected)],complete:true}}
    if(expected&&typeof expected==="object"&&!Array.isArray(expected)&&!(expected instanceof Date)){
      const entries=Object.entries(expected as DbDocument);
      if(entries.length===1&&entries[0][0]==="$in"&&Array.isArray(entries[0][1])&&(entries[0][1] as unknown[]).every(sqlPrimitive)){const wanted=entries[0][1] as Array<string|number|boolean|null>;if(!wanted.length)return{sql:"0",params:[],complete:true};const values=wanted.filter(value=>value!==null) as Array<string|number|boolean>,hasNull=wanted.some(value=>value===null),pieces:string[]=[],params:Array<string|number|null>=[];if(values.length){pieces.push(`${lineExpr} IN (${values.map(()=>"?").join(",")})`);params.push(...values.map(sqlValue))}if(hasNull)pieces.push(`${lineType}='null'`);return{sql:`EXISTS (SELECT 1 FROM json_each(data_json,'$.lines') line WHERE ${pieces.join(" OR ")})`,params,complete:true}}
      if(entries.length===1&&entries[0][0]==="$ne"&&sqlPrimitive(entries[0][1])){const wanted=entries[0][1];return wanted===null?{sql:`NOT EXISTS (SELECT 1 FROM json_each(data_json,'$.lines') line WHERE ${lineType}='null')`,params:[],complete:true}:{sql:`NOT EXISTS (SELECT 1 FROM json_each(data_json,'$.lines') line WHERE ${lineExpr}=?)`,params:[sqlValue(wanted)],complete:true}}
    }
    return{sql:"",params:[],complete:false};
  }
  if (!sqlFieldName.test(field) || field.includes(".") || !sqlScalarFields.has(field)) return {sql:"",params:[],complete:false};
  const keyField=field==="_id",expr=keyField?"record_key":jsonExpr(field),typeExpr=keyField?"":jsonTypeExpr(field);
  if (sqlPrimitive(expected)) {
    if (expected === null) return keyField ? {sql:"0",params:[],complete:true} : {sql:`${typeExpr}='null'`,params:[],complete:true};
    return {sql:`${expr}=?`,params:[keyField?String(expected):sqlValue(expected)],complete:true};
  }
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || expected instanceof Date) return {sql:"",params:[],complete:false};
  const clauses:string[]=[],params:Array<string|number|null>=[];let complete=true;
  for (const [op,wanted] of Object.entries(expected as DbDocument)) {
    if (op === "$options") { if (!("$regex" in (expected as DbDocument))) continue; complete=false; continue; }
    if (op === "$in" && Array.isArray(wanted) && wanted.every(sqlPrimitive)) {
      if (!wanted.length) { clauses.push("0"); continue; }
      const nonNull=wanted.filter(value=>value!==null) as Array<string|number|boolean>,includesNull=wanted.some(value=>value===null);
      const pieces:string[]=[];
      if(nonNull.length){pieces.push(`${expr} IN (${nonNull.map(()=>"?").join(",")})`);params.push(...nonNull.map(value=>keyField?String(value):sqlValue(value)))}
      if(includesNull&&!keyField)pieces.push(`${typeExpr}='null'`);
      clauses.push(`(${pieces.join(" OR ")||"0"})`);
      continue;
    }
    if (op === "$ne" && sqlPrimitive(wanted)) {
      if (wanted === null) {
        clauses.push(keyField ? "1" : `(${typeExpr} IS NULL OR ${typeExpr}<>'null')`);
      } else if (keyField) {
        clauses.push(`${expr}<>?`);params.push(String(wanted));
      } else {
        clauses.push(`(${typeExpr} IS NULL OR ${typeExpr}='null' OR ${expr}<>?)`);params.push(sqlValue(wanted));
      }
      continue;
    }
    if (op === "$exists" && typeof wanted === "boolean" && !keyField) { clauses.push(`${typeExpr} IS ${wanted?"NOT ":""}NULL`); continue; }
    if(op==="$type"&&!keyField&&(wanted==="string"||wanted==="number")){clauses.push(wanted==="string"?`${typeExpr}='text'`:`${typeExpr} IN ('integer','real')`);continue}
    if (["$gt","$gte","$lt","$lte"].includes(op) && sqlRangeFields.has(field) && (typeof wanted==="string"||typeof wanted==="number")) {
      const operator=op==="$gt"?">":op==="$gte"?">=":op==="$lt"?"<":"<=";clauses.push(`${expr}${operator}?`);params.push(wanted);continue;
    }
    complete=false;
  }
  return {sql:clauses.join(" AND "),params,complete};
}
function sqlCandidate(query:DbDocument={}):SqlCandidate {
  const clauses:string[]=[],params:Array<string|number|null>=[];let complete=true;
  for(const [field,expected] of Object.entries(query)){
    if(field==="$and"){
      if(!Array.isArray(expected)){complete=false;continue}
      for(const part of expected as DbDocument[]){const child=sqlCandidate(part);if(child.sql){clauses.push(`(${child.sql})`);params.push(...child.params)}if(!child.complete)complete=false}
      continue;
    }
    if(field==="$or"){
      if(!Array.isArray(expected)||!(expected as DbDocument[]).length){clauses.push("0");continue}
      const children=(expected as DbDocument[]).map(sqlCandidate);
      if(children.every(child=>child.complete&&child.sql)){clauses.push(`(${children.map(child=>`(${child.sql})`).join(" OR ")})`);for(const child of children)params.push(...child.params)}
      else complete=false;
      continue;
    }
    const candidate=sqlFieldCandidate(field,expected);if(candidate.sql){clauses.push(candidate.sql);params.push(...candidate.params)}if(!candidate.complete)complete=false;
  }
  return {sql:clauses.join(" AND "),params,complete};
}
const setPath = (row: DbDocument, path: string, value: any) => { const keys=path.split("."); let at=row; for(const key of keys.slice(0,-1)) at=at[key]??={}; at[keys.at(-1)!]=value; };
const unsetPath = (row: DbDocument, path: string) => { const keys=path.split("."); let at:any=row; for(const key of keys.slice(0,-1)){at=at?.[key];if(at==null)return}delete at[keys.at(-1)!]; };
const awaitProject=(rows:DbDocument[],spec:DbDocument)=>{const included=Object.entries(spec).filter(([,value])=>value);return rows.map(row=>{if(!included.length){const copy=structuredClone(row);for(const[key,value]of Object.entries(spec))if(!value)unsetPath(copy,key);return copy}const out:DbDocument={};for(const[key]of included)setPath(out,key,get(row,key));return out})};
function applyUpdate(row: DbDocument, update: DbDocument, inserted=false) {
  if (update.$set) for (const [key,value] of Object.entries(update.$set)) setPath(row,key,value);
  if (update.$inc) for (const [key,value] of Object.entries(update.$inc)) setPath(row,key,Number(get(row,key)??0)+Number(value));
  if (update.$max) for (const [key,value] of Object.entries(update.$max)) if(get(row,key)===undefined||get(row,key)<(value as any))setPath(row,key,value);
  if (inserted && update.$setOnInsert) for (const [key,value] of Object.entries(update.$setOnInsert)) setPath(row,key,value);
  if (update.$unset) for (const key of Object.keys(update.$unset)) unsetPath(row,key);
  const supported=new Set(["$set","$inc","$max","$setOnInsert","$unset"]);for(const key of Object.keys(update))if(key.startsWith("$")&&!supported.has(key))throw new Error(`Unsupported SQLite update operator: ${key}`);
  return row;
}

class Cursor {
  constructor(private rows: DbDocument[]) {}
  sort(spec: DbDocument){const entries=Object.entries(spec);this.rows.sort((a,b)=>{for(const[k,d]of entries){const x=get(a,k),y=get(b,k);if(x===y)continue;return(x<y?-1:1)*Number(d)}return 0});return this}
  limit(n:number){this.rows=this.rows.slice(0,n);return this} skip(n:number){this.rows=this.rows.slice(n);return this}
  project(spec:DbDocument){this.rows=this.rows.map(row=>{const included=Object.entries(spec).filter(([,v])=>v);if(!included.length){const copy=structuredClone(row);for(const[k,v]of Object.entries(spec))if(!v)unsetPath(copy,k);return copy}const out:DbDocument={};for(const[k]of included)setPath(out,k,get(row,k));return out});return this}
  toArray(){return Promise.resolve(this.rows.map(row=>structuredClone(row)))}
  async next(){return (await this.toArray())[0]}
}
class SqlCursor {
  private sortSpec:DbDocument|null=null;private skipCount=0;private limitCount:number|null=null;private projection:DbDocument|null=null;
  constructor(private db:Database.Database,private table:string,private candidate:SqlCandidate){}
  sort(spec:DbDocument){this.sortSpec=spec;return this}
  limit(n:number){this.limitCount=n;return this}
  skip(n:number){this.skipCount=n;return this}
  project(spec:DbDocument){this.projection=spec;return this}
  private sqlSortable(){return !this.sortSpec||Object.keys(this.sortSpec).every(key=>sqlFieldName.test(key)&&!key.includes(".")&&["_id","id","occurredAt","createdAt","name"].includes(key))}
  async toArray(){
    let rows:DbDocument[];
    if(!this.sqlSortable()){
      rows=(this.db.prepare(`SELECT data_json FROM ${this.table}${this.candidate.sql?` WHERE ${this.candidate.sql}`:""} ORDER BY rowid`).all(...this.candidate.params) as {data_json:string}[]).map(item=>decode(item.data_json));
      const cursor=new Cursor(rows);if(this.sortSpec)cursor.sort(this.sortSpec);if(this.skipCount)cursor.skip(this.skipCount);if(this.limitCount!==null)cursor.limit(this.limitCount);if(this.projection)cursor.project(this.projection);return cursor.toArray();
    }
    const where=this.candidate.sql?` WHERE ${this.candidate.sql}`:"",order=this.sortSpec?Object.entries(this.sortSpec).map(([key,direction])=>`${key==="_id"?"record_key":jsonExpr(key)} ${Number(direction)<0?"DESC":"ASC"}`).join(", "):"rowid ASC",params=[...this.candidate.params];
    let paging="";if(this.limitCount!==null){paging=" LIMIT ?";params.push(this.limitCount);if(this.skipCount){paging+=" OFFSET ?";params.push(this.skipCount)}}else if(this.skipCount){paging=" LIMIT -1 OFFSET ?";params.push(this.skipCount)}
    rows=(this.db.prepare(`SELECT data_json FROM ${this.table}${where} ORDER BY ${order}${paging}`).all(...params) as {data_json:string}[]).map(item=>decode(item.data_json));
    if(this.projection)rows=await new Cursor(rows).project(this.projection).toArray();
    return rows.map(row=>structuredClone(row));
  }
  async next(){return (await this.limit(1).toArray())[0]}
}
class Collection<T extends DbDocument=DbDocument> {
  constructor(private db: Database.Database, private table:string){}
  private all(query:DbDocument={}){const candidate=sqlCandidate(query),where=candidate.sql?` WHERE ${candidate.sql}`:"";return (this.db.prepare(`SELECT data_json FROM ${this.table}${where} ORDER BY rowid`).all(...candidate.params) as {data_json:string}[]).map(x=>decode(x.data_json))}
  private key(row:DbDocument){return String(row._id??row.id??row.key??crypto.randomUUID())}
  private save(row:DbDocument,key?:string){const id=key??this.key(row);if(row._id===undefined)row._id=id;this.db.prepare(`INSERT INTO ${this.table}(record_key,data_json) VALUES(?,?) ON CONFLICT(record_key) DO UPDATE SET data_json=excluded.data_json`).run(id,encode(row));return id}
  find(query:DbDocument={},options?:any){const candidate=sqlCandidate(query);if(candidate.complete){const cursor=new SqlCursor(this.db,this.table,candidate);if(options?.projection)cursor.project(options.projection);return cursor}let rows=this.all(query).filter(row=>matches(row,query));if(options?.projection)rows=awaitProject(rows,options.projection);return new Cursor(rows)}
  async findOne(query:DbDocument={},options?:any){const cursor=this.find(query);if(options?.sort)cursor.sort(options.sort);cursor.limit(1);if(options?.projection)cursor.project(options.projection);return ((await cursor.next())??null) as T|undefined}
  async insertOne(document:T,_options?:any){const row=structuredClone(document);const key=this.key(row);try{this.db.prepare(`INSERT INTO ${this.table}(record_key,data_json) VALUES(?,?)`).run(key,encode({...row,_id:row._id??key}));return{insertedId:key}}catch(error){const sqliteCode=String((error as any)?.code??"");if(sqliteCode==="SQLITE_CONSTRAINT_UNIQUE"||sqliteCode==="SQLITE_CONSTRAINT_PRIMARYKEY"){(error as any).sqliteCode=sqliteCode;(error as any).code=11000;(error as any).message=`duplicate key: ${(error as any).message}`}throw error}}
  async insertMany(documents:T[],_options?:any){if(!documents.length)return{insertedCount:0};const statement=this.db.prepare(`INSERT INTO ${this.table}(record_key,data_json) VALUES(?,?)`),standalone=!this.db.inTransaction;let inserted=0;if(standalone)this.db.exec("BEGIN IMMEDIATE");try{for(const document of documents){const row=structuredClone(document),key=this.key(row);try{statement.run(key,encode({...row,_id:row._id??key}));inserted++}catch(error){const sqliteCode=String((error as any)?.code??"");if(sqliteCode==="SQLITE_CONSTRAINT_UNIQUE"||sqliteCode==="SQLITE_CONSTRAINT_PRIMARYKEY"){(error as any).sqliteCode=sqliteCode;(error as any).code=11000;(error as any).message=`duplicate key: ${(error as any).message}`}throw error}}if(standalone)this.db.exec("COMMIT");return{insertedCount:inserted}}catch(error){if(standalone&&this.db.inTransaction)this.db.exec("COMMIT");throw error}}
  async updateOne(filter:DbDocument,update:DbDocument,options?:any){const found=this.all(filter).find(row=>matches(row,filter));if(found){this.save(applyUpdate(found,update),this.key(found));return{matchedCount:1,modifiedCount:1}}if(options?.upsert){const base=Object.fromEntries(Object.entries(filter).filter(([k,v])=>!k.startsWith("$")&&!(v&&typeof v==="object")));const row=applyUpdate(base,update,true);this.save(row);return{matchedCount:0,upsertedCount:1}}return{matchedCount:0,modifiedCount:0}}
  async updateMany(filter:DbDocument,update:DbDocument,_options?:any){let n=0;for(const row of this.all(filter).filter(x=>matches(x,filter))){this.save(applyUpdate(row,update),this.key(row));n++}return{matchedCount:n,modifiedCount:n}}
  async findOneAndUpdate(filter:DbDocument,update:DbDocument,options?:any){await this.updateOne(filter,update,options);return this.findOne(filter)}
  async deleteOne(filter:DbDocument,_options?:any){const row=this.all(filter).find(x=>matches(x,filter));if(!row)return{deletedCount:0};this.db.prepare(`DELETE FROM ${this.table} WHERE record_key=?`).run(this.key(row));return{deletedCount:1}}
  async deleteMany(filter:DbDocument,_options?:any){let n=0;for(const row of this.all(filter).filter(x=>matches(x,filter))){this.db.prepare(`DELETE FROM ${this.table} WHERE record_key=?`).run(this.key(row));n++}return{deletedCount:n}}
  countDocuments(query:DbDocument={}){const candidate=sqlCandidate(query);if(candidate.complete){const where=candidate.sql?` WHERE ${candidate.sql}`:"",row=this.db.prepare(`SELECT COUNT(*) count FROM ${this.table}${where}`).get(...candidate.params) as {count:number};return Promise.resolve(Number(row.count))}return Promise.resolve(this.all(query).filter(x=>matches(x,query)).length)}
  createIndex(..._args:any[]){throw new Error("Runtime createIndex is unsupported: define SQLite indexes in a schema migration")}
  async bulkWrite(ops:any[],_options?:any){for(const op of ops)if(op.updateOne)await this.updateOne(op.updateOne.filter,op.updateOne.update,op.updateOne)}
  aggregate(pipeline:DbDocument[]){let rows=this.all();for(const stage of pipeline){if(stage.$match)rows=rows.filter(r=>matches(r,stage.$match));else if(stage.$sort)rows=(new Cursor(rows).sort(stage.$sort) as any).rows;else if(stage.$unwind){const path=String(stage.$unwind).replace(/^\$/,'');rows=rows.flatMap(r=>(get(r,path)??[]).map((v:any)=>{const c=structuredClone(r);setPath(c,path,v);return c}))}else if(stage.$group){const groups=new Map<string,DbDocument>();for(const row of rows){const id=stage.$group._id===null?null:get(row,String(stage.$group._id).replace(/^\$/,''));const key=encode(id),out=groups.get(key)??{_id:id};for(const[field,expr]of Object.entries(stage.$group).slice(1)){const e=expr as any;if(e.$sum!==undefined){let value=e.$sum;if(typeof value==='string'&&value.startsWith('$'))value=get(row,value.slice(1));else if(value?.$cond){const[c,t,f]=value.$cond;value=matchesValue(get(row,String(c.$eq?.[0]??'').replace(/^\$/,'')),c.$eq?.[1])?(typeof t==='string'?get(row,t.slice(1)):t):(typeof f==='string'?get(row,f.slice(1)):f)}out[field]=Number(out[field]??0)+Number(value??0)}else if(e.$first!==undefined&&out[field]===undefined)out[field]=get(row,String(e.$first).replace(/^\$/,''));}groups.set(key,out)}rows=[...groups.values()]}}return new Cursor(rows)}
}

export class SqliteDatabase {
  constructor(readonly native:Database.Database){}
  collection<T extends DbDocument=DbDocument>(name:string){const table=tableNames[name];if(!table)throw new Error(`Unknown data set: ${name}`);return new Collection<T>(this.native,table)}
  command(_command?:any){return Promise.resolve({ok:1})}
  private writeTail:Promise<void>=Promise.resolve();
  async transaction<T>(work:(session:SqliteSession)=>Promise<T>){let release!:()=>void;const previous=this.writeTail;this.writeTail=new Promise<void>(resolve=>{release=resolve});await previous;try{this.native.exec("BEGIN IMMEDIATE");try{const result=await work({});this.native.exec("COMMIT");return result}catch(error){if(this.native.inTransaction)this.native.exec("ROLLBACK");throw error}}finally{release()}}
  async dropDatabase(){for(const table of Object.values(tableNames))this.native.prepare(`DELETE FROM ${table}`).run()}
  close(){if(this.native.open)this.native.close()}
}

export function databasePath(){return process.env.ALKARNA_DATABASE_PATH||join(process.env.ALKARNA_USER_DATA||join(process.cwd(),".dev-data"),"data","alkarna.sqlite")}
export function initializeDatabase(){if(database&&connection?.open)return database;const file=databasePath();mkdirSync(dirname(file),{recursive:true});connection=new Database(file);connection.pragma("foreign_keys = ON");connection.pragma("journal_mode = WAL");connection.pragma("synchronous = FULL");connection.pragma("busy_timeout = 5000");ensureDatabaseSchema(connection);database=new SqliteDatabase(connection);return database}
export function getDatabase(){return initializeDatabase()}
export function closeDatabase(){connection?.close();connection=undefined;database=undefined}
export function ensureDatabaseSchema(input:Database.Database|SqliteDatabase){const db=input instanceof SqliteDatabase?input.native:input;db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);`);let version=(db.prepare("SELECT max(version) version FROM schema_migrations").get() as any).version??0;if(version<1){db.transaction(()=>{for(const table of Object.values(tableNames))db.exec(`CREATE TABLE ${table}(record_key TEXT PRIMARY KEY,data_json TEXT NOT NULL)`);db.exec(`CREATE TABLE product_stocks(product_id TEXT NOT NULL,warehouse_id TEXT NOT NULL,quantity REAL NOT NULL,PRIMARY KEY(product_id,warehouse_id));CREATE TABLE document_lines(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,product_id TEXT,quantity REAL,unit_price INTEGER,line_total INTEGER);CREATE UNIQUE INDEX products_barcode_nonempty ON products(json_extract(data_json,'$.barcode')) WHERE json_extract(data_json,'$.barcode') IS NOT NULL AND json_extract(data_json,'$.barcode')<>'';`);db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(new Date().toISOString())})();seed(db);version=1}if(version<2){const indexes=[
 ["products_sku_nonempty","products","json_extract(data_json,'$.sku')","json_extract(data_json,'$.sku') IS NOT NULL AND json_extract(data_json,'$.sku')<>''"],
 ["products_legacy_key_nonempty","products","json_extract(data_json,'$.legacyKey')","json_extract(data_json,'$.legacyKey') IS NOT NULL AND json_extract(data_json,'$.legacyKey')<>''"],
 ["documents_number_unique","documents","json_extract(data_json,'$.number')","json_extract(data_json,'$.number') IS NOT NULL AND json_extract(data_json,'$.number')<>''"],
 ["documents_kind_sequence_unique","documents","json_extract(data_json,'$.kind'),json_extract(data_json,'$.sequence')","json_extract(data_json,'$.sequence') IS NOT NULL"],
 ["documents_sale_daily_sequence_unique","documents","json_extract(data_json,'$.businessDate'),json_extract(data_json,'$.dailySequence')","json_extract(data_json,'$.kind')='sale' AND json_extract(data_json,'$.businessDate') IS NOT NULL AND json_extract(data_json,'$.dailySequence') IS NOT NULL"],
 ["documents_recurring_occurrence_unique","documents","json_extract(data_json,'$.recurringId'),json_extract(data_json,'$.occurrenceKey')","json_extract(data_json,'$.recurringId') IS NOT NULL AND json_extract(data_json,'$.occurrenceKey') IS NOT NULL"],
 ["documents_legacy_key_nonempty","documents","json_extract(data_json,'$.legacyKey')","json_extract(data_json,'$.legacyKey') IS NOT NULL AND json_extract(data_json,'$.legacyKey')<>''"],
 ["payment_accounts_code_unique","payment_accounts","json_extract(data_json,'$.code')","json_extract(data_json,'$.code') IS NOT NULL AND json_extract(data_json,'$.code')<>''"],
 ["payment_accounts_legacy_key_unique","payment_accounts","json_extract(data_json,'$.legacyKey')","json_extract(data_json,'$.legacyKey') IS NOT NULL AND json_extract(data_json,'$.legacyKey')<>''"],
 ["financial_document_type_unique","financial_movements","json_extract(data_json,'$.documentId'),json_extract(data_json,'$.type')","json_extract(data_json,'$.documentId') IS NOT NULL AND json_extract(data_json,'$.type') IS NOT NULL"],
 ["users_username_normalized_unique","users","json_extract(data_json,'$.usernameNormalized')","json_extract(data_json,'$.usernameNormalized') IS NOT NULL AND json_extract(data_json,'$.usernameNormalized')<>''"],
 ["import_mapping_source_unique","import_mappings","json_extract(data_json,'$.sourceType'),json_extract(data_json,'$.sourceEntityType'),json_extract(data_json,'$.sourceKey')","json_extract(data_json,'$.sourceType') IS NOT NULL AND json_extract(data_json,'$.sourceEntityType') IS NOT NULL AND json_extract(data_json,'$.sourceKey') IS NOT NULL"],
 ] as const;db.transaction(()=>{for(const[name,table,expression,predicate]of indexes){try{db.exec(`CREATE UNIQUE INDEX ${name} ON ${table}(${expression}) WHERE ${predicate}`)}catch(error){throw new Error(`SQLite migration v2 cannot create ${name}; existing duplicate data must be corrected without deleting records: ${String((error as Error).message)}`)}}db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(new Date().toISOString())})();version=2}if(version<3){const indexes=[["warehouses_legacy_key_unique","warehouses"],["parties_legacy_key_unique","parties"]] as const;db.transaction(()=>{for(const[name,table]of indexes){try{db.exec(`CREATE UNIQUE INDEX ${name} ON ${table}(json_extract(data_json,'$.legacyKey')) WHERE json_extract(data_json,'$.legacyKey') IS NOT NULL AND json_extract(data_json,'$.legacyKey')<>''`)}catch(error){throw new Error(`SQLite migration v3 cannot create ${name}; existing duplicate data must be corrected without deleting records: ${String((error as Error).message)}`)}}db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(new Date().toISOString())})();version=3}if(version<4){db.transaction(()=>{db.exec(`CREATE TABLE IF NOT EXISTS product_categories(record_key TEXT PRIMARY KEY,data_json TEXT NOT NULL)`);db.prepare("INSERT INTO schema_migrations VALUES(4,?)").run(new Date().toISOString())})();version=4}if(version<5){db.transaction(()=>{db.exec(`DROP INDEX IF EXISTS financial_document_type_unique;CREATE UNIQUE INDEX financial_document_type_active_unique ON financial_movements(json_extract(data_json,'$.documentId'),json_extract(data_json,'$.type')) WHERE json_extract(data_json,'$.documentId') IS NOT NULL AND json_extract(data_json,'$.type') IS NOT NULL AND COALESCE(json_extract(data_json,'$.status'),'posted')<>'reversed' AND COALESCE(json_extract(data_json,'$.isReversal'),0)<>1;`);db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(new Date().toISOString())})();version=5}if(version<6){const indexes=[
["documents_id_idx","documents","json_extract(data_json,'$.id')"],
["products_id_idx","products","json_extract(data_json,'$.id')"],
["parties_id_idx","parties","json_extract(data_json,'$.id')"],
["documents_kind_status_time_idx","documents","json_extract(data_json,'$.kind'),json_extract(data_json,'$.status'),json_extract(data_json,'$.occurredAt')"],
["documents_party_status_time_idx","documents","json_extract(data_json,'$.partyId'),json_extract(data_json,'$.status'),json_extract(data_json,'$.occurredAt')"],
["documents_payment_time_idx","documents","json_extract(data_json,'$.paymentMethod'),json_extract(data_json,'$.occurredAt')"],
["financial_time_idx","financial_movements","json_extract(data_json,'$.occurredAt')"],
["financial_account_time_idx","financial_movements","json_extract(data_json,'$.paymentMethod'),json_extract(data_json,'$.occurredAt')"],
["financial_party_time_idx","financial_movements","json_extract(data_json,'$.partyId'),json_extract(data_json,'$.occurredAt')"],
["stock_product_time_idx","stock_movements","json_extract(data_json,'$.productId'),json_extract(data_json,'$.occurredAt')"],
["account_transfers_time_idx","account_transfers","json_extract(data_json,'$.occurredAt')"],
["products_category_idx","products","json_extract(data_json,'$.categoryId')"],
["parties_type_archived_idx","parties","json_extract(data_json,'$.partyType'),json_extract(data_json,'$.isArchived')"],
] as const;db.transaction(()=>{for(const[name,table,expression]of indexes)db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${expression})`);db.prepare("INSERT INTO schema_migrations VALUES(6,?)").run(new Date().toISOString())})();version=6}if(version<7){const indexes=[
["documents_status_time_idx","documents","json_extract(data_json,'$.status'),json_extract(data_json,'$.occurredAt')"],
["stock_time_idx","stock_movements","json_extract(data_json,'$.occurredAt')"],
["products_expiry_idx","products","json_extract(data_json,'$.expiryDate')"],
] as const;db.transaction(()=>{for(const[name,table,expression]of indexes)db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${expression})`);db.prepare("INSERT INTO schema_migrations VALUES(7,?)").run(new Date().toISOString())})();version=7}cleanupExpiredRecords(db);const check=db.pragma("quick_check") as any[];if(check[0]?.quick_check!=="ok")throw new Error("SQLite quick_check failed")}export function cleanupExpiredRecords(db:Database.Database){for(const table of ["command_receipts","legacy_import_runs","import_runs","import_safety_backups","restore_snapshots"])db.prepare(`DELETE FROM ${table} WHERE json_extract(data_json,'$.expiresAt') IS NOT NULL AND datetime(json_extract(data_json,'$.expiresAt')) <= datetime('now')`).run();db.prepare("DELETE FROM command_receipts WHERE json_extract(data_json,'$.status')='committed' AND datetime(json_extract(data_json,'$.createdAt')) < datetime('now','-7 days')").run()}
function seed(db:Database.Database){const now=new Date().toISOString(),put=(table:string,key:string,data:any)=>db.prepare(`INSERT OR IGNORE INTO ${table}(record_key,data_json) VALUES(?,?)`).run(key,encode({...data,_id:key}));put("warehouses","wh-main",{name:"المخزن الرئيسي",isSalesDefault:false,createdAt:now});put("warehouses","wh-boutique",{name:"البوتيك",isSalesDefault:true,createdAt:now});for(const[code,name,color,icon]of [["cash","نقدي","#16835f","banknote"],["bankily","بنكيلي","#1677c8","wallet"],["masrvi","مصرفي","#6d55c7","building"],["sedad","السداد","#d07a20","landmark"],["bimbank","بيم","#c14666","card"]])put("payment_accounts",`account-${code}`,{id:`account-${code}`,code,name,color,icon,isActive:true,balance:0,balanceInitialized:true,createdAt:now})}