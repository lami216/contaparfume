import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

const source=path.resolve(process.env.ACCOUNTING_RECOVERY_SOURCE??fileURLToPath(new URL('../',import.meta.url)));
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const missing=Symbol('absent snapshot');
const fixtureParent=path.resolve(process.env.ACCOUNTING_RECOVERY_AUDIT??os.tmpdir());
const preserveProfiles=Boolean(process.env.ACCOUNTING_RECOVERY_AUDIT);
let sqlite;
async function fixture(t,label='case'){
 if(sqlite)sqlite.closeDatabase();
 const parent=fixtureParent;fs.mkdirSync(parent,{recursive:true});const profile=fs.mkdtempSync(path.join(parent,'recovery-'+label+'-'));for(const name of ['data','config','licensing','temp'])fs.mkdirSync(path.join(profile,name),{recursive:true});
 process.env.ALKARNA_USER_DATA=profile;process.env.ALKARNA_DATABASE_PATH=path.join(profile,'data/audit.sqlite');process.env.ALKARNA_LICENSE_STATE_PATH=path.join(profile,'licensing/state-v2.json');process.env.ALKARNA_LICENSE_DISABLE_REGISTRY='1';process.env.ALKARNA_DESKTOP='1';process.env.TEMP=path.join(profile,'temp');process.env.TMP=process.env.TEMP;
 sqlite??=await load('lib/sqlite.ts');let db=sqlite.initializeDatabase();await db.dropDatabase();
 const recovery=await load('lib/sale-cost-recovery.ts'),backup=await load('lib/backup.ts'),{POST,execute}=await load('app/api/command/route.ts'),{GET:healthGET}=await load('app/api/accounting-health/route.ts'),{GET:reportGET}=await load('app/api/reports/route.ts'),auth=await load('lib/auth.ts'),{SEQUENCED_DOCUMENT_KINDS:sequenceKinds}=await load('lib/document-sequences.ts');
 const categorySetup=fs.existsSync(path.join(source,'lib/perfume-system-categories.ts'))?(await load('lib/perfume-system-categories.ts')).ensurePerfumeSystemCategories:null;
 t.after(()=>{sqlite.closeDatabase();if(!preserveProfiles&&fs.existsSync(profile)){const relative=path.relative(fs.realpathSync(parent),fs.realpathSync(profile));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Only remove the owned synthetic fixture');fs.rmSync(profile,{recursive:true,force:true})}});
 const origin='http://127.0.0.1:3341';
 function request(url,user='owner',body,key){const cookie=user===null?'':auth.SESSION_COOKIE+'='+auth.createSession({principalType:user==='owner'?'owner':'user',...(user==='owner'?{}:{userId:user})});return new Request(origin+url,{method:body?'POST':'GET',headers:{origin,host:'127.0.0.1:3341',...(cookie?{cookie}:{}),'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})})}
 const response=async(handler,request)=>{const r=await handler(request);return{status:r.status,body:await r.json()}};
 const receiptKey=key=>path.basename(profile)+':'+key;
 const post=(body,key='review',user='owner')=>response(POST,request('/api/command',user,body,receiptKey(key)));
 const health=(user='owner',query='')=>response(healthGET,request('/api/accounting-health'+query,user));
 const report=(query='type=sales&allTime=true',user='owner')=>response(reportGET,request('/api/reports?'+query,user));
 return{get db(){return db},profile,recovery,backup,post,receiptKey,health,report,execute,sequenceKinds,async canonicalCategories(){if(categorySetup)await categorySetup(db)},async reopen(){sqlite.closeDatabase();db=sqlite.initializeDatabase();return db},doc:id=>db.collection('documents').findOne({id}),async owners(){await db.collection('users').insertMany([{id:'owner',name:'Synthetic owner',isActive:true,permissions:[]},{id:'employee',username:'employee',name:'Synthetic employee with all capabilities',isActive:true,permissions:[...auth.CAPABILITIES]}])}};
}
async function seed(f,{cost=missing,price=100,status='posted',sourceExtra={},saleExtra={},productExtra={},extraSources=[],sourceKind='purchase'}={}){
 const sourceLine={id:'purchase-line',productId:'p',description:'Synthetic item',quantity:4,unitPrice:price,lineTotal:400};
 const purchase={id:'purchase',number:'PUR-TEST',sequence:1,revision:0,kind:sourceKind,status,occurredAt:'2026-09-01T10:00:00.000Z',warehouseId:'w',warehouseName:'Synthetic warehouse',paymentMethod:'cash',total:400,paidTotal:400,dueTotal:0,lines:[sourceLine],...sourceExtra};
 const line={id:'sale-line',productId:'p',description:'Synthetic item',quantity:2,unitPrice:150,lineTotal:300,...(cost===missing?{}:{costAtSale:cost}),grossProfit:cost===missing||cost===null?null:300-2*Number(cost)};
 const sale={id:'sale',number:'SAL-TEST',sequence:1,dailySequence:1,revision:0,kind:'sale',status:'posted',occurredAt:'2026-09-10T10:00:00.000Z',businessDate:'2026-09-10',warehouseId:'w',warehouseName:'Synthetic warehouse',partyId:'customer',partyName:'Synthetic customer',paymentMethod:'note',total:300,paidTotal:0,dueTotal:300,lines:[line],...saleExtra};
 await f.db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});await f.db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',openingBalance:1000,balance:600,isActive:true});await f.db.collection('parties').insertOne({id:'customer',name:'Synthetic customer',partyType:'customer',receivable:300,payable:0,net:300});
 await f.db.collection('products').insertOne({id:'p',sku:'1',name:'Synthetic item',pieceCost:999,lastPurchaseCost:999,piecePrice:150,stocks:{w:2},...productExtra});
 await f.db.collection('documents').insertMany([purchase,...extraSources.map((extra,index)=>({...structuredClone(purchase),id:'source-'+index,number:'PUR-EXTRA-'+index,...extra})),sale]);
 await f.db.collection('stockMovements').insertMany([{id:'purchase-stock',documentId:'purchase',productId:'p',warehouseId:'w',type:'purchase',quantityDelta:4,balanceBefore:0,balanceAfter:4,occurredAt:purchase.occurredAt},{id:'sale-stock',documentId:'sale',productId:'p',warehouseId:'w',type:'sale',quantityDelta:-2,balanceBefore:4,balanceAfter:2,occurredAt:sale.occurredAt}]);
 await f.db.collection('financialMovements').insertOne({id:'purchase-cash',documentId:'purchase',documentNumber:purchase.number,type:'purchase',status:'posted',direction:'out',amount:400,paymentMethod:'cash',occurredAt:purchase.occurredAt});await f.db.collection('appSettings').insertOne({_id:'branding',name:'Synthetic immutable branding'});await f.db.collection('auditEvents').insertOne({id:'prior-audit',action:'prior-event',before:{retained:true}});await f.db.collection('counters').insertMany([...f.sequenceKinds.map(kind=>({_id:'documentSequence:'+kind,value:['sale','purchase'].includes(kind)?1:0})),{_id:'productSequence',value:1}]);await f.canonicalCategories();
 return{purchase:await f.doc('purchase'),sale:await f.doc('sale')};
}
async function operational(f,{receipts=true}={}){const names=['products','warehouses','parties','paymentAccounts','stockMovements','financialMovements','counters',...(receipts?['commandReceipts']:[])];return Object.fromEntries(await Promise.all(names.map(async name=>[name,await f.db.collection(name).find().toArray()])))}
async function all(f){return{operational:await operational(f),documents:await f.db.collection('documents').find().toArray(),audits:await f.db.collection('auditEvents').find().toArray(),settings:await f.db.collection('appSettings').find().toArray()}}
function backupComparable(snapshot){const value=structuredClone(snapshot);value.operational.counters=value.operational.counters.map(row=>{delete row.createdAt;delete row.updatedAt;return row});return value}
function withoutCost(doc,{manual=false}={}){const value=structuredClone(doc);for(const line of value.lines??[]){delete line.costAtSale;delete line.grossProfit;delete line.saleCostRecovery}if(manual){delete value.revision;delete value.updatedAt}return value}
const journals=f=>f.db.collection('auditEvents').find({version:1,action:{$in:['sale-cost-recovery.automatic','sale-cost-recovery.confirm']}}).toArray();
const rowBody=(row,action='apply-suggested')=>({type:'sale-cost-recovery.confirm',documentId:row.documentId,lineId:row.lineId,expectedRevision:row.revision,reviewToken:row.reviewToken,action,reason:'Synthetic independent review'});

test('automatic recovery preserves exact absence/null before-images and only hydrates proven ordinary sale cost',async t=>{
 for(const cost of [missing,null]){const f=await fixture(t,'auto'),before=await seed(f,{cost}),immutable=await operational(f),summary=f.recovery.recoverHistoricalSaleCosts(f.db),after=await f.doc('sale'),audit=await journals(f);assert.equal(summary.automaticRecovered,1);assert.equal(after.lines[0].costAtSale,100);assert.equal(after.lines[0].grossProfit,100);assert.deepEqual(withoutCost(after),withoutCost(before.sale));assert.deepEqual(await operational(f),immutable);assert.equal(audit.length,1);assert.deepEqual(audit[0].beforeDocument,before.sale);assert.deepEqual(audit[0].afterDocument,after);assert.equal(Object.hasOwn(audit[0].beforeDocument.lines[0],'costAtSale'),cost!==missing);if(cost===null)assert.equal(audit[0].beforeDocument.lines[0].costAtSale,null);assert.equal(audit[0].source.documentId,'purchase');assert.equal(audit[0].source.unitCost,100);assert.equal((await f.doc('purchase')).lines[0].unitPrice,100)}
});

test('known positive snapshots and legitimate numeric/string zero are never automatically rewritten',async t=>{
 for(const cost of [70,0,'0']){const f=await fixture(t,'known'),before=await seed(f,{cost}),immutable=await operational(f);const summary=f.recovery.recoverHistoricalSaleCosts(f.db);assert.equal(summary.automaticRecovered,0);assert.deepEqual(await f.doc('sale'),before.sale);assert.deepEqual(await operational(f),immutable);assert.equal((await journals(f)).length,0);assert.equal(summary.savedZeroReview,cost===70?0:1)}
});

test('future, voided, imported, edited, malformed, ambiguous, and later-posted sources remain unknown',async t=>{
 const variants=[{name:'future',sourceExtra:{occurredAt:'2026-09-20T10:00:00.000Z'}},{name:'voided',status:'voided'},{name:'imported-source',sourceExtra:{legacyKey:'synthetic-import'}},{name:'edited-source',sourceExtra:{revision:1}},{name:'imported-sale',saleExtra:{legacyKey:'synthetic-sale-import'}},{name:'null',price:null},{name:'boolean',price:true},{name:'empty',price:''},{name:'zero',price:0},{name:'negative',price:-100},{name:'bad-total',sourceExtra:{total:399}},{name:'ties',sourceExtra:{sequence:null},extraSources:[{sequence:null,lines:[{id:'conflict',productId:'p',quantity:4,unitPrice:120,lineTotal:480}],total:480}]},{name:'latest-malformed',extraSources:[{occurredAt:'2026-09-05T10:00:00.000Z',sequence:2,lines:[{id:'latest',productId:'p',quantity:4,unitPrice:null,lineTotal:400}]}]},{name:'voided-latest-older',extraSources:[{status:'voided',occurredAt:'2026-09-05T10:00:00.000Z',sequence:2,lines:[{id:'voided-latest',productId:'p',quantity:4,unitPrice:120,lineTotal:480}],total:480}]},{name:'future-latest-older',extraSources:[{occurredAt:'2026-09-20T10:00:00.000Z',sequence:2,lines:[{id:'future-latest',productId:'p',quantity:4,unitPrice:120,lineTotal:480}],total:480}]}];
 for(const variant of variants){const f=await fixture(t,variant.name),before=await seed(f,variant),immutable=await operational(f);const summary=f.recovery.recoverHistoricalSaleCosts(f.db);assert.equal(summary.automaticRecovered,0,variant.name);assert.deepEqual(await f.doc('sale'),before.sale,variant.name);assert.deepEqual(await operational(f),immutable);assert.equal((await journals(f)).length,0);assert.equal(summary.unresolved,1)}
 const f=await fixture(t,'later-posting'),before=await seed(f),late={...before.purchase,id:'late-posted',number:'PUR-LATE',sequence:2,occurredAt:'2026-09-05T10:00:00.000Z',lines:[{id:'late-line',productId:'p',quantity:4,unitPrice:120,lineTotal:480}],total:480};delete late._id;await f.db.collection('documents').insertOne(late);f.recovery.recoverHistoricalSaleCosts(f.db);assert.deepEqual(await f.doc('sale'),before.sale);assert.equal((await journals(f)).length,0);
});

test('opening proof requires a positive saved balance; a zero/invalid opening cannot supply historic cost',async t=>{
 for(const after of [0,-1,null]){const f=await fixture(t,'bad-opening'),before=await seed(f,{sourceKind:'adjustment',sourceExtra:{number:'OPEN-COR-TEST',openingCorrection:true,openingStockAfter:after,openingCostAfter:100,total:0,lines:[{id:'opening-line',productId:'p',quantity:0,unitPrice:100,lineTotal:0}]}});f.recovery.recoverHistoricalSaleCosts(f.db);assert.deepEqual(await f.doc('sale'),before.sale,'opening after '+after);assert.equal((await journals(f)).length,0)}
 const f=await fixture(t,'good-opening');await seed(f,{sourceKind:'adjustment',sourceExtra:{number:'OPEN-COR-TEST',openingCorrection:true,openingStockAfter:4,openingCostAfter:100,total:0,lines:[{id:'opening-line',productId:'p',quantity:-2,unitPrice:100,lineTotal:0}]}});f.recovery.recoverHistoricalSaleCosts(f.db);assert.equal((await f.doc('sale')).lines[0].costAtSale,100);
});

test('startup and repeated recovery are idempotent and preserve stock, cash, debt, dates, revisions and prior edit history',async t=>{
 const f=await fixture(t,'restart'),before=await seed(f,{saleExtra:{revision:2,editHistory:[{revision:1,occurredAt:'2026-09-10T10:00:00.000Z',lines:[{id:'sale-line',costAtSale:null}]}]}}),immutable=await operational(f);await f.reopen();const after=await f.doc('sale');assert.equal(after.lines[0].costAtSale,100);assert.deepEqual(withoutCost(after),withoutCost(before.sale));assert.deepEqual(await operational(f),immutable);const first=await all(f);f.recovery.recoverHistoricalSaleCosts(f.db);assert.deepEqual(await all(f),first);await f.reopen();assert.deepEqual(await all(f),first);
});

test('injected second automatic document write failure rolls back every repair, journal and marker; restart retries safely',async t=>{
 const f=await fixture(t,'atomic-auto');await seed(f);const second={...await f.doc('sale'),id:'sale2',number:'SAL-2',sequence:2,dailySequence:2,lines:[{...(await f.doc('sale')).lines[0],id:'sale2-line'}]};delete second._id;await f.db.collection('documents').insertOne(second);const before=await all(f);f.db.native.exec("CREATE TRIGGER independent_auto_fail BEFORE UPDATE ON documents WHEN NEW.record_key='sale2' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECOVERY_FAILURE'); END");assert.throws(()=>f.recovery.recoverHistoricalSaleCosts(f.db),/SYNTHETIC_RECOVERY_FAILURE/);assert.deepEqual(await all(f),before);f.db.native.exec('DROP TRIGGER independent_auto_fail');await f.reopen();assert.equal((await f.doc('sale')).lines[0].costAtSale,100);assert.equal((await f.doc('sale2')).lines[0].costAtSale,100);assert.equal((await journals(f)).length,2);
});

test('native backup roundtrip retains recovery journals and restoring an older backup hydrates again in the existing transaction',async t=>{
 const f=await fixture(t,'backup');await seed(f);const old=f.backup.parseAndValidateBackup(JSON.stringify(await f.backup.createNativeBackup(f.db)));f.recovery.recoverHistoricalSaleCosts(f.db);const repaired=f.backup.parseAndValidateBackup(JSON.stringify(await f.backup.createNativeBackup(f.db))),first=await all(f);await f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,repaired,session));assert.deepEqual(backupComparable(await all(f)),backupComparable(first));await f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,old,session));assert.equal((await f.doc('sale')).lines[0].costAtSale,100);assert.equal((await journals(f)).length,1);const backup=f.backup.parseAndValidateBackup(JSON.stringify(await f.backup.createNativeBackup(f.db)));assert(backup.collections.auditEvents.some(e=>e.action==='sale-cost-recovery.automatic'));assert(backup.collections.appSettings.some(s=>(s.id??s._id)==='sale-cost-recovery:v1'));assert.deepEqual(backupComparable(await all(f)).operational,backupComparable(first).operational);
});

test('recovery journal failure during native restore rolls the entire replacement back before a safe retry',async t=>{
 const f=await fixture(t,'restore-rollback');await seed(f);const old=f.backup.parseAndValidateBackup(JSON.stringify(await f.backup.createNativeBackup(f.db)));f.recovery.recoverHistoricalSaleCosts(f.db);const before=await all(f);f.db.native.exec("CREATE TRIGGER independent_restore_fail BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='sale-cost-recovery.automatic' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RESTORE_RECOVERY_FAILURE'); END");await assert.rejects(f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,old,session)),/SYNTHETIC_RESTORE_RECOVERY_FAILURE/);assert.deepEqual(await all(f),before);f.db.native.exec('DROP TRIGGER independent_restore_fail');await f.db.transaction(session=>f.backup.restoreNativeBackup(f.db,old,session));assert.equal((await f.doc('sale')).lines[0].costAtSale,100);assert.equal((await journals(f)).length,1);
});

test('perfume decant, glass and returned-partial snapshots/allocations are excluded from automatic and owner recovery',async t=>{
 for(const form of ['decant','bottle','partial']){const f=await fixture(t,form),before=await seed(f,{cost:null,productExtra:{perfumeForm:form,perfumeStockUnit:form==='decant'?'ml':undefined},saleExtra:{kind:form==='decant'?'decant-sale':'sale'}});f.recovery.recoverHistoricalSaleCosts(f.db);assert.deepEqual(await f.doc('sale'),before.sale);assert.equal(f.recovery.accountingHealth(f.db).rows.length,0);assert.equal((await journals(f)).length,0)}
 const f=await fixture(t,'allocated'),before=await seed(f);await f.db.collection('documents').updateOne({id:'sale'},{$set:{lines:[{...before.sale.lines[0],perfumeAllocations:[{lotId:'historic-lot',warehouseId:'w',quantity:20,unitCost:10,quantityUnit:'ml'}],liquidQuantityMl:20}]}});const document=await f.doc('sale');f.recovery.recoverHistoricalSaleCosts(f.db);assert.deepEqual(await f.doc('sale'),document);assert.equal(f.recovery.accountingHealth(f.db).rows.length,0);
});

test('untagged generated perfume evidence blocks automatic and owner recosting while a normal full perfume remains eligible',async t=>{
 const generated=[{perfumeLots:[{id:'old-lot',sourceProductId:'old-full',sourceProductName:'Old full perfume',remainingQuantity:2,originalQuantity:4,stocks:{w:2},liquidUnitCost:50,landedUnitCost:50,bottleCost:0,decantSizeMl:10,createdAt:'2026-09-01T10:00:00.000Z',conversionDocumentId:'old-conversion'}]},{parentProductId:'old-full'},{decantSizeMl:10}];
 for(const extra of generated)for(const cost of [null,0]){const f=await fixture(t,'untagged-generated'),before=await seed(f,{cost,productExtra:extra});await f.owners();const immutable=await operational(f),summary=f.recovery.recoverHistoricalSaleCosts(f.db);assert.equal(summary.automaticRecovered,0);assert.deepEqual(await f.doc('sale'),before.sale);assert.equal(f.recovery.accountingHealth(f.db).rows.length,0);const response=await f.post({type:'sale-cost-recovery.confirm',documentId:'sale',lineId:'sale-line',expectedRevision:0,reviewToken:'unavailable',action:'set-reviewed-cost',reviewedUnitCost:100,reason:'Synthetic attempted generated recost'},'generated-review');assert.equal(response.status,400);assert(response.body.error.includes('العملية غير مدعومة'));assert.deepEqual(await f.doc('sale'),before.sale);assert.deepEqual(await operational(f),immutable);assert.equal((await journals(f)).length,0)}
 const full=await fixture(t,'ordinary-full');await seed(full,{productExtra:{perfumeForm:'full',perfumeBottleVolumeMl:100,originalVolumeMl:100,parentProductId:null,decantSizeMl:null,perfumeLots:[]}});assert.equal(full.recovery.recoverHistoricalSaleCosts(full.db).automaticRecovered,1);assert.equal((await full.doc('sale')).lines[0].costAtSale,100);
});

test('manual cost entry is unavailable to owner and staff, and diagnostics remain read-only', async t => {
  const f = await fixture(t, 'no-manual-cost-entry');
  await seed(f, { cost: 0 });
  await f.owners();
  assert.equal((await f.health(null)).status, 401);
  assert.equal((await f.health('employee')).status, 403);
  const status = await f.health();
  assert.equal(status.status, 200);
  const row = status.body.rows[0];
  assert.equal(row.suggestedPriorCost, 100);
  const before = await all(f);
  for (const user of ['owner', 'employee']) {
    for (const action of ['apply-suggested', 'confirm-zero', 'set-reviewed-cost']) {
      const body = { ...rowBody(row, action), reviewedUnitCost: 100, actor: { principalType: 'owner' } };
      assert.equal((await f.post(body, user + action, user)).status, 400);
      await assert.rejects(f.db.transaction(session => f.execute(f.db, session, body)));
    }
  }
  assert.deepEqual(await all(f), before);
});

test('legacy confirmed zero and its original owner journal survive backup restore and invoice edit', async t => {
  const f = await fixture(t, 'legacy-zero');
  await seed(f, { cost: 0 });
  await f.owners();
  const row = (await f.health()).body.rows[0];
  f.recovery.confirmSaleCostRecovery(f.db, rowBody(row, 'confirm-zero'), { principalType: 'owner', name: 'Legacy owner' });
  const beforeDoc = await f.doc('sale'), beforeJournals = await journals(f);
  const backup = f.backup.parseAndValidateBackup(JSON.stringify(await f.backup.createNativeBackup(f.db)));
  await f.db.transaction(session => f.backup.restoreNativeBackup(f.db, backup, session));
  assert.deepEqual(await f.doc('sale'), beforeDoc);
  assert.deepEqual(await journals(f), beforeJournals);
  assert.equal((await f.health()).body.summary.reviewedZero, 1);
  const edit = await f.post({ type: 'sale.update', documentId: 'sale', warehouseId: 'w', paymentMethod: 'cash', lines: [{ productId: 'p', quantity: 2, piecePrice: 150 }] }, 'payment-edit');
  assert.equal(edit.status, 200);
  const after = await f.doc('sale');
  assert.equal(after.lines[0].costAtSale, 0);
  assert.deepEqual(after.lines[0].saleCostRecovery, beforeDoc.lines[0].saleCostRecovery);
  assert.deepEqual(await journals(f), beforeJournals);
});

test('actual new sale refuses malformed latest purchase cost instead of substituting an opening/card cost',async t=>{
 for(const price of [null,true,0]){const f=await fixture(t,'latest-bad');await seed(f,{price,productExtra:{openingCost:100,legacyOpeningCost:100}});await f.owners();const sale=await f.post({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:'p',quantity:1,piecePrice:150}]},'new-sale');assert.equal(sale.status,200,JSON.stringify(sale));const doc=await f.doc(sale.body.id);assert.equal(doc.lines[0].costAtSale,null);assert.equal(doc.lines[0].grossProfit,null);const report=await f.report();assert.equal(report.status,200);assert(report.body.summary.unknownRevenue>=150);assert.equal(report.body.summary.costKnown,false)}
});


