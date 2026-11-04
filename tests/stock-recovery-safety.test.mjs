import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {sqliteHarness} from './sqlite-harness.mjs';
import {closeDatabase,initializeDatabase} from '../lib/sqlite.ts';
import {createNativeBackup,restoreNativeBackup} from '../lib/backup.ts';
import {recoverHistoricalStockData} from '../lib/stock-data-recovery.ts';
import {createStockRecoverySafetySnapshot} from '../lib/stock-recovery-safety.ts';
const at='2026-11-03T12:00:00.000Z';
const safetyDirectory=db=>join(dirname(db.native.name),'stock-recovery');
const snapshots=db=>existsSync(safetyDirectory(db))?readdirSync(safetyDirectory(db)).filter(name=>name.endsWith('.db')):[];
const rows=async db=>Object.fromEntries(await Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts','auditEvents','appSettings'].map(async name=>[name,await db.collection(name).find().toArray()])));
async function seed(db,{corrected=false,uncertain=false,multiple=false}={}){
 const warehouses=multiple?['w','w2']:['w'];
 await db.collection('warehouses').insertMany([...warehouses.map((id,index)=>({_id:id,name:'Synthetic '+id,isSalesDefault:index===0})),{_id:'other',name:'Untouched',isSalesDefault:false}]);
 await db.collection('products').insertOne({id:'p',sku:'1',name:'Synthetic repair item',pieceCost:100,lastPurchaseCost:100,stocks:Object.fromEntries([...warehouses.map(id=>[id,corrected?2:'11']),['other','03']])});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,openingBalance:1000,balance:1000-warehouses.length*200});
 for(const[index,warehouseId]of warehouses.entries()){
  const purchase={id:'purchase-'+warehouseId,number:'PUR-'+warehouseId,sequence:index+1,revision:0,kind:'purchase',status:'posted',warehouseId,paymentMethod:'cash',partyId:null,occurredAt:at,total:200,paidTotal:200,dueTotal:0,lines:[{id:'purchase-line-'+warehouseId,productId:'p',quantity:2,unitPrice:100,lineTotal:200}]};
  const sale={id:'sale-'+warehouseId,number:'SAL-'+warehouseId,sequence:index+1,dailySequence:index+1,revision:1,kind:'sale',status:'voided',warehouseId,paymentMethod:'cash',partyId:null,occurredAt:at,businessDate:'2026-11-03',voidedAt:at,total:150,paidTotal:150,dueTotal:0,lines:[{id:'sale-line-'+warehouseId,productId:'p',quantity:'1',unitPrice:150,lineTotal:150,costAtSale:100,grossProfit:50}]};
  await db.collection('documents').insertMany([purchase,sale]);
  const movement=(id,document,type,quantityDelta,balanceBefore,balanceAfter,documentRevision)=>({id,documentId:document.id,documentNumber:document.number,productId:'p',warehouseId,type,quantityDelta,balanceBefore,balanceAfter,documentRevision,occurredAt:at});
  await db.collection('stockMovements').insertMany([movement('buy-'+warehouseId,purchase,'purchase',2,0,2,0),...(!uncertain?[movement('sell-'+warehouseId,sale,'sale',-1,2,1,0)]:[]),movement('void-'+warehouseId,sale,'sale-void',corrected?1:'1',1,corrected?2:'11',1)]);
  await db.collection('financialMovements').insertMany([{id:'pay-'+warehouseId,documentId:purchase.id,paymentMethod:'cash',type:'purchase',direction:'out',amount:200,delta:-200,status:'posted',occurredAt:at},{id:'sale-money-'+warehouseId,documentId:sale.id,paymentMethod:'cash',type:'sale',direction:'in',amount:150,delta:150,status:'reversed',occurredAt:at},{id:'refund-'+warehouseId,documentId:sale.id,paymentMethod:'cash',type:'sale-void',direction:'out',amount:150,delta:-150,status:'posted',isReversal:true,reversalOf:'sale-money-'+warehouseId,occurredAt:at}]);
 }
}
function verifiedSnapshot(db,event){
 const evidence=event.safetySnapshot;assert.equal(evidence.kind,'sqlite');assert(!/[\\/]/.test(evidence.fileName));
 const file=join(safetyDirectory(db),evidence.fileName),bytes=readFileSync(file);assert.equal(bytes.length,evidence.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),evidence.sha256);
 const copy=new Database(file,{readonly:true,fileMustExist:true});assert.equal(copy.pragma('quick_check',{simple:true}),'ok');assert.equal(copy.pragma('journal_mode',{simple:true}),'delete');return copy;
}

test('a verified safety snapshot contains uncommitted incoming rows and survives later commit or rollback',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();await seed(h.db,{corrected:true});let evidence;
 await h.db.transaction(async()=>{await h.db.collection('products').updateOne({id:'p'},{$set:{'stocks.w':'11'}});evidence=createStockRecoverySafetySnapshot(h.db,{context:'incoming-test'});await h.db.collection('products').updateOne({id:'p'},{$set:{'stocks.w':2}})});
 const copy=verifiedSnapshot(h.db,{safetySnapshot:evidence});try{assert.equal(JSON.parse(copy.prepare('SELECT data_json FROM products').get().data_json).stocks.w,'11')}finally{copy.close()}
 assert.equal((await h.db.collection('products').findOne({id:'p'})).stocks.w,2);
 let rollbackEvidence;await assert.rejects(h.db.transaction(async()=>{await h.db.collection('products').updateOne({id:'p'},{$set:{'stocks.w':'20'}});rollbackEvidence=createStockRecoverySafetySnapshot(h.db,{context:'rollback-test'});throw new Error('Synthetic rollback')}),/Synthetic rollback/);
 const rolledBack=verifiedSnapshot(h.db,{safetySnapshot:rollbackEvidence});try{assert.equal(JSON.parse(rolledBack.prepare('SELECT data_json FROM products').get().data_json).stocks.w,'20')}finally{rolledBack.close()}
 assert.equal((await h.db.collection('products').findOne({id:'p'})).stocks.w,2);
});
test('native restore repairs incoming concatenation once, preserves its raw snapshot and never invents a stock movement',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();await seed(h.db);const input=await createNativeBackup(h.db),before=await rows(h.db);
 await h.db.transaction(session=>restoreNativeBackup(h.db,input,session));
 const after=await rows(h.db);assert.equal(after.products[0].stocks.w,2);assert.equal(after.products[0].stocks.other,'03');assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.financialMovements,before.financialMovements);assert.deepEqual(after.paymentAccounts,before.paymentAccounts);assert.equal(after.stockMovements.length,3);assert.equal(after.stockMovements.find(row=>row.type==='sale-void').balanceAfter,2);
 const events=after.auditEvents.filter(event=>event.action==='stock-data-recovery.automatic');assert.equal(events.length,1);const copy=verifiedSnapshot(h.db,events[0]);try{assert.equal(JSON.parse(copy.prepare('SELECT data_json FROM products').get().data_json).stocks.w,'11');assert.equal(JSON.parse(copy.prepare("SELECT data_json FROM stock_movements WHERE record_key='void-w'").get().data_json).balanceAfter,'11')}finally{copy.close()}
 const repaired=await createNativeBackup(h.db),count=snapshots(h.db).length;await h.db.transaction(session=>restoreNativeBackup(h.db,repaired,session));assert.equal(snapshots(h.db).length,count);assert.equal((await h.db.collection('auditEvents').find({action:'stock-data-recovery.automatic'}).toArray()).length,1);
 closeDatabase();const restarted=initializeDatabase();assert.equal((await restarted.collection('products').findOne({id:'p'})).stocks.w,2);assert.equal(snapshots(restarted).length,count);
 await restarted.transaction(session=>restoreNativeBackup(restarted,input,session));assert.equal((await restarted.collection('products').findOne({id:'p'})).stocks.w,2);assert.equal(snapshots(restarted).length,count+1,'An older restored dataset is checked again, never hidden by a global marker');
});
test('healthy and uncertain-only histories create no safety files, settings or mutation journals',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());for(const options of [{corrected:true},{uncertain:true}]){await h.reset();await seed(h.db,options);const before=await rows(h.db),count=snapshots(h.db).length;const result=recoverHistoricalStockData(h.db,{context:'no-op-test'});assert.equal(result.repaired,0);assert.deepEqual(await rows(h.db),before);assert.equal(snapshots(h.db).length,count)}
});
test('a blocked safety directory fails closed before product, movement or journal writes',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();await seed(h.db);writeFileSync(safetyDirectory(h.db),'Synthetic path blocker');const before=await rows(h.db);assert.throws(()=>recoverHistoricalStockData(h.db,{context:'failure-test'}),/نسخة أمان/);assert.deepEqual(await rows(h.db),before);
});
test('a later audit failure rolls back product and movement repair while retaining its verified pre-change snapshot',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();await seed(h.db);const before=await rows(h.db);h.db.native.exec("CREATE TRIGGER reject_stock_recovery BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='stock-data-recovery.automatic' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STOCK_AUDIT_FAILURE'); END");assert.throws(()=>recoverHistoricalStockData(h.db));assert.deepEqual(await rows(h.db),before);assert.equal(snapshots(h.db).length,1);
 h.db.native.exec('DROP TRIGGER reject_stock_recovery');assert.equal(recoverHistoricalStockData(h.db).repaired,1);assert.equal((await h.db.collection('products').findOne({id:'p'})).stocks.w,2);
});
test('two warehouse repairs share one snapshot and evolve the full product compare-and-set image',async t=>{
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();await seed(h.db,{multiple:true});assert.equal(recoverHistoricalStockData(h.db).repaired,2);const product=await h.db.collection('products').findOne({id:'p'});assert.deepEqual(product.stocks,{w:2,w2:2,other:'03'});const events=await h.db.collection('auditEvents').find({action:'stock-data-recovery.automatic'}).toArray();assert.equal(events.length,2);assert.equal(events[1].beforeProductRaw,events[0].afterProductRaw);assert.equal(snapshots(h.db).length,1);
});
