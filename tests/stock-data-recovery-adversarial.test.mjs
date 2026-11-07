import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const source=path.resolve(process.env.STOCK_RECOVERY_SOURCE??fileURLToPath(new URL('../',import.meta.url))),parent=path.resolve(process.env.STOCK_RECOVERY_AUDIT??os.tmpdir()),load=file=>import(pathToFileURL(path.join(source,file)).href);
let sqlite;
async function fixture(t){
 sqlite?.closeDatabase();fs.mkdirSync(parent,{recursive:true});const profile=fs.mkdtempSync(path.join(parent,'stock-recovery-independent-'));for(const name of ['data','temp','licensing','config'])fs.mkdirSync(path.join(profile,name));
 Object.assign(process.env,{NODE_ENV:'test',ALKARNA_DESKTOP:'1',ALKARNA_USER_DATA:profile,ALKARNA_DATABASE_PATH:path.join(profile,'data/synthetic.sqlite'),ALKARNA_LICENSE_STATE_PATH:path.join(profile,'licensing/state-v2.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1',ALKARNA_TEST_LICENSE_BYPASS:'1',TEMP:path.join(profile,'temp'),TMP:path.join(profile,'temp')});
 sqlite??=await load('lib/sqlite.ts');let db=sqlite.initializeDatabase();await db.dropDatabase();const recovery=await load('lib/stock-data-recovery.ts'),backup=await load('lib/backup.ts'),{POST}=await load('app/api/command/route.ts'),{GET:reports}=await load('app/api/reports/route.ts'),opening=await load('lib/opening-stock.ts');
 t.after(()=>{sqlite.closeDatabase();process.env.TEMP=parent;process.env.TMP=parent;if(!process.env.STOCK_RECOVERY_AUDIT){assert.equal(path.dirname(profile),parent);assert(path.basename(profile).startsWith('stock-recovery-independent-'));fs.rmSync(profile,{recursive:true,force:true});}});
 await db.collection('warehouses').insertMany([{_id:'w',name:'Synthetic first warehouse',isSalesDefault:true},{_id:'w2',name:'Synthetic other warehouse',isSalesDefault:false}]);await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,openingBalance:100000,balance:100000});
 const origin='http://127.0.0.1:3456';let sequence=0;
 async function post(body,key){const r=await POST(new Request(origin+'/api/command',{method:'POST',headers:{origin,host:'127.0.0.1:3456','content-type':'application/json','Idempotency-Key':path.basename(profile)+':'+(key??++sequence)},body:JSON.stringify(body)}));return{status:r.status,body:await r.json()};}
 const ok=async(body,key)=>{const r=await post(body,key);assert.equal(r.status,200,JSON.stringify(r));return r.body.id;};
 const table=name=>db.native.prepare(`SELECT record_key,data_json,rowid FROM ${name} ORDER BY rowid`).all().map(row=>({...row,value:JSON.parse(row.data_json)}));
 const snapshot=()=>({products:table('products'),documents:table('documents'),stockMovements:table('stock_movements'),warehouses:table('warehouses')});
 const journals=()=>db.collection('auditEvents').find({action:recovery.STOCK_DATA_RECOVERY_ACTION}).toArray();
 const frozen=async()=>Object.fromEntries(await Promise.all(['documents','financialMovements','parties','paymentAccounts','counters','commandReceipts'].map(async name=>[name,await db.collection(name).find().toArray()])));
 return{get db(){return db;},profile,recovery,backup,opening,post,ok,table,snapshot,journals,frozen,p:id=>db.collection('products').findOne({id}),doc:id=>db.collection('documents').findOne({id}),async reopen(){sqlite.closeDatabase();db=sqlite.initializeDatabase();return db;},async report(){const r=await reports(new Request(origin+'/api/reports?type=overview&allTime=true',{headers:{host:'127.0.0.1:3456'}}));assert.equal(r.status,200);return(await r.json()).summary;}};
}
async function corruptFixture(f,{quantity=2,opening=false}={}){
 const p=await f.ok({type:'product.create',name:'Synthetic terminal corruption',pieceCost:100,piecePrice:150,...(opening?{openingStock:quantity,openingCost:100,openingWarehouseId:'w'}:{})});
 if(!opening)await f.ok({type:'purchase.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:p,quantity,unitPrice:100}]});
 const sale=await f.ok({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:p,quantity:1,piecePrice:150}]}),document=await f.doc(sale);document.lines[0].quantity='1';await f.db.collection('documents').updateOne({id:sale},{$set:{lines:document.lines}});await f.ok({type:'sale.void',documentId:sale},'original-void-'+sale);
 const movement=await f.db.collection('stockMovements').findOne({documentId:sale,type:'sale-void'}),raw=String(movement.balanceBefore)+'1';
 // Fixture only: the unchanged historical command module was independently
 // reproduced committing exactly these two malformed snapshots. Actual current
 // POSTs above create every business document, movement and financial reversal.
 await f.db.collection('products').updateOne({id:p},{$set:{'stocks.w':raw}});await f.db.collection('stockMovements').updateOne({id:movement.id},{$set:{quantityDelta:'1',balanceAfter:raw}});
 return{p,sale,movementId:movement.id,raw,corrected:quantity};
}
function changeRow(row,mutate){mutate(row.value);row.data_json=JSON.stringify(row.value);}
function rowBy(rows,id){return rows.find(row=>row.value.id===id);}
function physicalSnapshot(f,evidence){const file=path.join(f.profile,'data/stock-recovery',evidence.fileName);assert.equal(fs.statSync(file).size,evidence.bytes);assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),evidence.sha256);return file;}

test('real POST history repairs a proven terminal 11 to two with exact raw journal and verified pre-change SQLite',async t=>{
 const f=await fixture(t),item=await corruptFixture(f),before=f.snapshot(),frozen=await f.frozen(),beforeReport=await f.report(),plan=f.recovery.planHistoricalStockRecovery(before);assert.equal(plan.repairs.length,1);assert.equal(plan.repairs[0].kind,'quantity-correction');assert.equal(plan.repairs[0].afterStock,2);
 const summary=f.recovery.recoverHistoricalStockData(f.db,{context:'independent'});assert.equal(summary.repaired,1);assert.equal(summary.quantityCorrected,1);assert.equal((await f.p(item.p)).stocks.w,2);assert.deepEqual(await f.frozen(),frozen);
 const audits=await f.journals();assert.equal(audits.length,1);const audit=audits[0],priorProduct=rowBy(before.products,item.p),priorMovement=rowBy(before.stockMovements,item.movementId),priorSource=rowBy(before.documents,item.sale);assert.equal(audit.beforeProductRaw,priorProduct.data_json);assert.equal(audit.beforeMovementRaw,priorMovement.data_json);assert.equal(audit.sourceDocumentRaw,priorSource.data_json);assert.deepEqual(audit.sourceDocument,priorSource.value);assert.equal(audit.kind,'quantity-correction');assert.equal(audit.status,'committed');assert.equal(audit.beforeMovement.quantityDelta,'1');assert.equal(audit.afterMovement.quantityDelta,1);assert.equal(audit.afterMovement.balanceAfter,2);assert.equal((await f.doc(item.sale)).lines[0].quantity,'1');assert.equal(f.table('stock_movements').length,before.stockMovements.length,'No compensating business movement is invented');
 const Database=(await import(pathToFileURL(path.join(source,'node_modules/better-sqlite3/lib/index.js')).href)).default,copy=new Database(physicalSnapshot(f,summary.safetySnapshot),{readonly:true});try{assert.equal(copy.pragma('quick_check',{simple:true}),'ok');assert.equal(JSON.parse(copy.prepare("SELECT data_json FROM products WHERE json_extract(data_json,'$.id')=?").get(item.p).data_json).stocks.w,'11');assert.equal(JSON.parse(copy.prepare("SELECT data_json FROM stock_movements WHERE json_extract(data_json,'$.id')=?").get(item.movementId).data_json).balanceAfter,'11');}finally{copy.close();}
 const afterReport=await f.report();assert.equal(beforeReport.currentInventoryValue-afterReport.currentInventoryValue,900);for(const key of ['sales','purchases','inventoryLoss','inventoryGain','netOperatingResult','currentAccountsBalance'])assert.equal(afterReport[key],beforeReport[key],key);
});

test('01 is a type-only repair and a genuine quantity eleven is never guessed to be two',async t=>{
 const f=await fixture(t),item=await corruptFixture(f,{quantity:1});const result=f.recovery.recoverHistoricalStockData(f.db);assert.equal(result.repaired,1);assert.equal(result.quantityCorrected,0);assert.equal(result.typeNormalized,1);assert.equal((await f.p(item.p)).stocks.w,1);
 const healthy=structuredClone(f.snapshot());changeRow(rowBy(healthy.products,item.p),p=>{p.stocks.w='11';});changeRow(rowBy(healthy.stockMovements,item.movementId),m=>{m.balanceBefore=10;m.quantityDelta=1;m.balanceAfter=11;});assert.equal(f.recovery.planHistoricalStockRecovery(healthy).repairs.length,0);
});

test('forged incomplete duplicated edited imported absolute and nonterminal histories are not auto-corrected',async t=>{
 const f=await fixture(t),item=await corruptFixture(f),base=f.snapshot();const mutations=[
  ['missing source',s=>{s.documents=s.documents.filter(row=>row.value.id!==item.sale);}],
  ['missing original withdrawal',s=>{s.stockMovements=s.stockMovements.filter(row=>row.value.type!=='sale');}],
  ['dangling prior purchase',s=>{s.documents=s.documents.filter(row=>row.value.kind!=='purchase');}],
  ['source raw type mismatch',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.lines[0].quantity=1;})],
  ['source malformed quantity',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.lines[0].quantity=null;})],
  ['source quantity mismatch',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.lines[0].quantity='2';})],
  ['duplicate source lines',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.lines.push({...d.lines[0],id:'duplicate-line'});})],
  ['source edited revision',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.revision=2;})],
  ['source not voided',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.status='posted';})],
  ['source imported',s=>changeRow(rowBy(s.documents,item.sale),d=>{d.legacyKey='synthetic-import';})],
  ['forged movement family',s=>changeRow(rowBy(s.stockMovements,item.movementId),m=>{m.type='purchase-void';})],
  ['forged document number',s=>changeRow(rowBy(s.stockMovements,item.movementId),m=>{m.documentNumber='forged';})],
  ['wrong warehouse',s=>changeRow(rowBy(s.stockMovements,item.movementId),m=>{m.warehouseId='w2';})],
  ['missing warehouse',s=>{s.warehouses=s.warehouses.filter(row=>row.value._id!=='w');}],
  ['conflicting canonical warehouse alias',s=>changeRow(s.warehouses.find(row=>row.value._id==='w'),w=>{w._id='different-canonical';w.id='w';})],
  ['current cell mismatch',s=>changeRow(rowBy(s.products,item.p),p=>{p.stocks.w='12';})],
  ['no zero anchor',s=>changeRow(s.stockMovements[0],m=>{m.balanceBefore=1;m.balanceAfter=3;})],
  ['earlier arithmetic drift',s=>changeRow(s.stockMovements[0],m=>{m.quantityDelta=3;})],
  ['unknown prior operation',s=>changeRow(s.stockMovements[0],m=>{m.type='unproven-import';})],
  ['absolute count barrier',s=>changeRow(s.stockMovements[0],m=>{m.type='adjustment';})],
  ['transfer barrier',s=>changeRow(s.stockMovements[0],m=>{m.type='transfer-in';})],
  ['duplicate movement identity',s=>{const r=structuredClone(rowBy(s.stockMovements,item.movementId));r.record_key+='-copy';r.rowid+=100;s.stockMovements.push(r);}],
  ['repeated source event',s=>{const r=structuredClone(rowBy(s.stockMovements,item.movementId));r.record_key+='-copy';r.rowid+=100;changeRow(r,m=>{m.id+='-copy';});s.stockMovements.push(r);}],
  ['later cell movement',s=>{const r=structuredClone(rowBy(s.stockMovements,item.movementId));r.record_key+='-later';r.rowid+=100;changeRow(r,m=>{m.id+='-later';m.type='sale';m.quantityDelta=-1;m.balanceBefore=11;m.balanceAfter=10;});s.stockMovements.push(r);}],
  ['child return link',s=>{const r=structuredClone(rowBy(s.documents,item.sale));r.record_key='synthetic-return';r.rowid+=100;changeRow(r,d=>{d.id='synthetic-return';d.number='RET-SYNTHETIC';d.kind='return';d.parentDocumentId=item.sale;});s.documents.push(r);}],
  ['duplicate row order',s=>{s.stockMovements.at(-1).rowid=s.stockMovements[0].rowid;}],
  ['reverse original row order',s=>{const original=s.stockMovements.find(r=>r.value.type==='sale'),terminal=rowBy(s.stockMovements,item.movementId);[original.rowid,terminal.rowid]=[terminal.rowid,original.rowid];}],
 ];
 for(const[name,mutate]of mutations){const input=structuredClone(base);mutate(input);const unchanged=JSON.stringify(input),plan=f.recovery.planHistoricalStockRecovery(input);assert.equal(plan.repairs.length,0,name);assert.equal(JSON.stringify(input),unchanged,name+' must not mutate input');}
});

test('a proven warehouse cell is repaired independently while all other warehouse cells and history remain exact',async t=>{
 const f=await fixture(t),item=await corruptFixture(f);await f.db.collection('products').updateOne({id:item.p},{$set:{'stocks.w2':'03'}});const before=f.snapshot(),summary=f.recovery.recoverHistoricalStockData(f.db);assert.equal(summary.repaired,1);assert.deepEqual((await f.p(item.p)).stocks,{w:2,w2:'03'});assert.equal(f.table('stock_movements').length,before.stockMovements.length);
});

test('generated perfume evidence is excluded while an ordinary full bottle remains eligible',async t=>{
 const f=await fixture(t),item=await corruptFixture(f),base=f.snapshot();for(const extra of [{perfumeForm:'decant'},{perfumeForm:'bottle'},{perfumeForm:'partial'},{perfumeLots:[{id:'old-lot'}]},{parentProductId:'original'},{sourceProductId:'original'},{perfumeStockUnit:'ml'},{decantSizeMl:10},{partialVolumeMl:40},{legacyKey:'imported-product'}]){const input=structuredClone(base);changeRow(rowBy(input.products,item.p),p=>Object.assign(p,extra));assert.equal(f.recovery.planHistoricalStockRecovery(input).repairs.length,0,JSON.stringify(extra));}
 const ordinary=structuredClone(base);changeRow(rowBy(ordinary.products,item.p),p=>Object.assign(p,{perfumeForm:'full',originalVolumeMl:100}));assert.equal(f.recovery.planHistoricalStockRecovery(ordinary).repairs.length,1);
});

test('opening entitlement and snapshots are unchanged by correcting a proven void, with no fake loss or gain',async t=>{
 const f=await fixture(t),item=await corruptFixture(f,{opening:true}),beforeProduct=await f.p(item.p),before=await f.opening.deriveOpeningStockState(f.db,undefined,beforeProduct),docs=await f.frozen(),report=await f.report();assert.equal(before.remaining,2);assert.equal(before.consumed,0);assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,1);const afterProduct=await f.p(item.p),after=await f.opening.deriveOpeningStockState(f.db,undefined,afterProduct);assert.deepEqual(after,before);assert.deepEqual(await f.frozen(),docs);for(const key of ['openingStock','openingCost','openingWarehouseId'])assert.equal(afterProduct[key],beforeProduct[key]);const afterReport=await f.report();for(const key of ['sales','purchases','inventoryLoss','inventoryGain','netOperatingResult'])assert.equal(afterReport[key],report[key],key);
});

test('healthy and unsupported profiles are true no-ops with no journal marker or safety snapshot',async t=>{
 const f=await fixture(t),p=await f.ok({type:'product.create',name:'Synthetic healthy',pieceCost:100,piecePrice:150});await f.ok({type:'purchase.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:p,quantity:11,unitPrice:100}]});const before=f.snapshot(),changes=f.db.native.totalChanges??f.db.native.prepare('SELECT total_changes() AS n').get().n,settings=await f.db.collection('appSettings').find().toArray();assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,0);assert.deepEqual(f.snapshot(),before);assert.deepEqual(await f.db.collection('appSettings').find().toArray(),settings);assert.equal((await f.journals()).length,0);assert(!fs.existsSync(path.join(f.profile,'data/stock-recovery')));assert.equal(f.db.native.prepare('SELECT total_changes() AS n').get().n,changes);
});

test('SQL journal failure rolls back every product and movement, and a later retry repairs only once',async t=>{
 const f=await fixture(t),item=await corruptFixture(f),before=f.snapshot(),frozen=await f.frozen();f.db.native.exec("CREATE TRIGGER independent_recovery_audit_failure BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='stock-data-recovery.automatic' BEGIN SELECT RAISE(ABORT,'injected stock audit failure'); END");assert.throws(()=>f.recovery.recoverHistoricalStockData(f.db),/injected stock audit failure/);assert.deepEqual(f.snapshot(),before);assert.deepEqual(await f.frozen(),frozen);assert.equal((await f.journals()).length,0);assert.equal(f.db.native.inTransaction,false);f.db.native.exec('DROP TRIGGER independent_recovery_audit_failure');assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,1);const after=f.snapshot(),journal=await f.journals();assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,0);assert.deepEqual(f.snapshot(),after);assert.deepEqual(await f.journals(),journal);assert.equal((await f.p(item.p)).stocks.w,2);
});

test('an ignored optimistic product update cannot leave a movement-only repair or audit',async t=>{
 const f=await fixture(t);await corruptFixture(f);const before=f.snapshot();f.db.native.exec("CREATE TRIGGER independent_recovery_ignore BEFORE UPDATE ON products BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>f.recovery.recoverHistoricalStockData(f.db),/تغير سجل المخزون/);assert.deepEqual(f.snapshot(),before);assert.equal((await f.journals()).length,0);f.db.native.exec('DROP TRIGGER independent_recovery_ignore');assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,1);
});

test('a failed safety snapshot causes zero data changes rather than an unsafe repair',async t=>{
 const f=await fixture(t);await corruptFixture(f);const before=f.snapshot(),frozen=await f.frozen();fs.writeFileSync(path.join(f.profile,'data/stock-recovery'),'synthetic path obstruction');assert.throws(()=>f.recovery.recoverHistoricalStockData(f.db),error=>error.status===409&&error.message.includes('نسخة أمان'));assert.deepEqual(f.snapshot(),before);assert.deepEqual(await f.frozen(),frozen);assert.equal((await f.journals()).length,0);
});

test('startup retries and native backup restore preserve exact repair evidence and future numeric sale/void behavior',async t=>{
 const f=await fixture(t),item=await corruptFixture(f),incoming=await f.backup.createNativeBackup(f.db),sourceDoc=await f.doc(item.sale);await f.reopen();assert.equal((await f.p(item.p)).stocks.w,2);assert.equal((await f.journals()).length,1);const after=f.snapshot();await f.reopen();assert.deepEqual(f.snapshot(),after);assert.equal((await f.journals()).length,1);
 const reviewed=f.backup.parseAndValidateBackup(f.backup.stringifyBackup(await f.backup.createNativeBackup(f.db)));await f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,reviewed,session));assert.equal((await f.p(item.p)).stocks.w,2);assert.equal((await f.journals()).length,1);assert.deepEqual(await f.doc(item.sale),sourceDoc);
 await f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,incoming,session));assert.equal((await f.p(item.p)).stocks.w,2);assert.equal((await f.journals()).length,1);const sale=await f.ok({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:item.p,quantity:1,piecePrice:150}]});assert.equal((await f.p(item.p)).stocks.w,1);await f.ok({type:'sale.void',documentId:sale},'future-void');assert.equal((await f.p(item.p)).stocks.w,2);const beforeRetry=f.snapshot();assert.equal((await f.post({type:'sale.void',documentId:sale},'future-void')).status,200);assert.deepEqual(f.snapshot(),beforeRetry);assert.equal((await f.post({type:'sale.void',documentId:sale},'different-void')).status,404);assert.equal(f.recovery.recoverHistoricalStockData(f.db).repaired,0);
});

test('an outer restore transaction rollback removes repaired rows and journal while its verified pre-change copy remains valid',async t=>{
 const f=await fixture(t);await corruptFixture(f);const before=f.snapshot();let evidence;await assert.rejects(f.db.transaction(async()=>{await f.db.collection('warehouses').insertOne({_id:'uncommitted',name:'Synthetic uncommitted warehouse',isSalesDefault:false});evidence=f.recovery.recoverHistoricalStockData(f.db).safetySnapshot;throw new Error('outer synthetic failure');}),/outer synthetic failure/);assert.deepEqual(f.snapshot(),before);assert.equal((await f.journals()).length,0);const Database=(await import(pathToFileURL(path.join(source,'node_modules/better-sqlite3/lib/index.js')).href)).default,copy=new Database(physicalSnapshot(f,evidence),{readonly:true});try{assert.equal(copy.prepare("SELECT count(*) AS n FROM warehouses WHERE json_extract(data_json,'$._id')='uncommitted'").get().n,1,'The verified copy includes the incoming uncommitted restore view');}finally{copy.close();}
});

test('large healthy and unsupported snapshots remain linear-size no-ops without mutating their input',async t=>{
 const f=await fixture(t),base=f.snapshot();for(const count of [1000,5000]){const state={products:[],documents:[],stockMovements:[],warehouses:structuredClone(base.warehouses)};for(let i=0;i<count;i++){const id='p-'+i,doc='unsupported-'+i,stored=(value,rowid)=>({record_key:String(value.id),rowid,value,data_json:JSON.stringify(value)});state.products.push(stored({id,stocks:{w:'11'}},i+1));state.documents.push(stored({id:doc,number:doc,kind:'untrusted',status:'voided',revision:1},i+1));state.stockMovements.push(stored({id:'m-'+i,productId:id,documentId:doc,warehouseId:'w',type:'sale-void',quantityDelta:'1',balanceBefore:1,balanceAfter:'11'},i+1));}const original=JSON.stringify(state),start=performance.now(),result=f.recovery.planHistoricalStockRecovery(state),elapsed=performance.now()-start;assert.equal(result.repairs.length,0);assert.equal(JSON.stringify(state),original);t.diagnostic(JSON.stringify({scenario:'large unsupported no-op',count,elapsedMs:elapsed}));for(const row of state.stockMovements)changeRow(row,m=>{m.type='sale';m.quantityDelta=-1;m.balanceAfter=0;});assert.equal(f.recovery.planHistoricalStockRecovery(state).repairs.length,0);}
});
