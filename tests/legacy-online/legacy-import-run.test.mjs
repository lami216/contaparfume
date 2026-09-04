import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { executeLegacyImportPhase, LEGACY_IMPORT_PHASES } from "../legacy/dataacc-sqlite.ts";
import { ensureDatabaseSchema } from "../lib/mongodb.ts";

function realisticFixture(){
 const statements=[
  "CREATE TABLE itemsTB(id INTEGER,title TEXT,code TEXT,priceUnit REAL,last_cost REAL)","CREATE TABLE storesTB(id INTEGER,title TEXT)","CREATE TABLE stores_itemsTB(id INTEGER,store_idFK INTEGER,item_idFK INTEGER,qty REAL)",
  "CREATE TABLE customerTB(id INTEGER,title TEXT,phone TEXT,Creditor REAL,Debitor REAL)","CREATE TABLE suppliersTB(id INTEGER,title TEXT,phone TEXT,Creditor REAL,Debitor REAL)","CREATE TABLE BankTB(id INTEGER,BankName TEXT,rasid REAL)",
  "CREATE TABLE buyBillTB(id INTEGER,Date TEXT,CustomerFK INTEGER,StoreFK INTEGER,priceBillAfterKhasm REAL,PaidMony REAL,remainMony REAL,Billcode TEXT)","CREATE TABLE items_BuyTB(id INTEGER,BuyFK INTEGER,item_idFK INTEGER,title TEXT,qty REAL,price_Buy REAL,LastCost REAL)",
  "CREATE TABLE purchBillTB(id INTEGER,Date TEXT,SuppFK INTEGER,StoreFK INTEGER,priceBill REAL,PaidMony REAL,remainMony REAL,Billcode TEXT)","CREATE TABLE items_purchTB(id INTEGER,purchFK INTEGER,item_idFK INTEGER,title TEXT,qty REAL,price_purch REAL)","CREATE TABLE safeTB(id INTEGER,QtyMoney REAL,Pand TEXT,Date TEXT,BankID INTEGER)"
 ];
 const values=[];for(let i=1;i<=300;i++)values.push(`INSERT INTO itemsTB VALUES(${i},'Product ${i}','BC${i}',10,4)`);for(let i=1;i<=3;i++)values.push(`INSERT INTO storesTB VALUES(${i},'Store ${i}')`);for(let i=1;i<=300;i++)values.push(`INSERT INTO stores_itemsTB VALUES(${i},${i%3+1},${i},${i%17})`);for(let i=1;i<=4;i++)values.push(`INSERT INTO customerTB VALUES(${i},'Customer ${i}','200${i}',0,${i})`);values.push("INSERT INTO suppliersTB VALUES(1,'Supplier','3001',2,0)");for(let i=1;i<=5;i++)values.push(`INSERT INTO BankTB VALUES(${i},'Bank ${i}',${i*100})`);
 let line=0;for(let i=1;i<=500;i++){values.push(`INSERT INTO buyBillTB VALUES(${i},'2024-01-${String(i%28+1).padStart(2,'0')} 10:00:00',${i%4+1},${i%3+1},30,20,10,'S${i}')`);for(let x=0;x<2;x++){line++;values.push(`INSERT INTO items_BuyTB VALUES(${line},${i},${(line%300)+1},'Line',1,15,4)`)}}
 line=0;for(let i=1;i<=120;i++){values.push(`INSERT INTO purchBillTB VALUES(${i},'2023-12-${String(i%28+1).padStart(2,'0')} 10:00:00',1,${i%3+1},20,20,0,'P${i}')`);for(let x=0;x<4;x++){line++;values.push(`INSERT INTO items_purchTB VALUES(${line},${i},${(line%300)+1},'Line',1,5)`)}}for(let i=1;i<=8;i++)values.push(`INSERT INTO safeTB VALUES(${i},10,'Expense','2024-01-01 10:00:00',1)`);
 return initSqlJs().then(SQL=>{const sqlite=new SQL.Database();sqlite.run([...statements,...values].join(";"));const bytes=new Uint8Array(sqlite.export());sqlite.close();return bytes.slice()});
}

test("realistic batched import completes, links records, and is idempotent",{timeout:120000},async()=>{const server=await MongoMemoryServer.create(),client=new MongoClient(server.getUri());await client.connect();const db=client.db("legacy-run");try{await ensureDatabaseSchema(db);const bytes=await realisticFixture(),roundTrips=[];for(const phase of LEGACY_IMPORT_PHASES)roundTrips.push((await executeLegacyImportPhase(db,bytes,phase)).mongoRoundTrips);assert.equal(await db.collection("products").countDocuments({legacyKey:/^dataacc:itemsTB:/}),300);assert.equal(await db.collection("documents").countDocuments({kind:"sale",legacyKey:{$exists:true}}),500);assert.equal(await db.collection("documents").countDocuments({kind:"purchase",legacyKey:{$exists:true}}),120);assert.equal(await db.collection("stockMovements").countDocuments({legacyKey:{$exists:true}}),300);assert.equal((await db.collection("documents").findOne({kind:"sale"})).lines.length,2);assert.ok((await db.collection("documents").find({partyId:null,kind:{$in:["sale","purchase"]}}).count())===0);const before=await db.collection("documents").countDocuments();for(const phase of LEGACY_IMPORT_PHASES)await executeLegacyImportPhase(db,bytes,phase);assert.equal(await db.collection("documents").countDocuments(),before);assert.equal(await db.collection("documents").countDocuments({legacyKey:{$exists:true}}),628);assert.ok(roundTrips.reduce((a,b)=>a+b,0)<50);}finally{await client.close();await server.stop()}});

test("reading an import run returns public status without mutating it", async () => {
 const { getLegacyImportRun } = await import("../legacy/import-run.ts");
 const stored={id:"run-1",state:"products",phase:"products",progress:{processed:127,total:326,label:"المنتجات"},counts:{},reviewCount:0};
 let writes=0;
 const db={collection(name){return {findOne:async query=>{assert.deepEqual(query,{id:"run-1"});return name==="importRuns"?stored:null},updateOne:async()=>{writes++}}}};
 const status=await getLegacyImportRun(db,"run-1");
 assert.equal(status.importRunId,"run-1");assert.equal(status.phase,"products");assert.deepEqual(status.progress,stored.progress);assert.equal(writes,0);
});
