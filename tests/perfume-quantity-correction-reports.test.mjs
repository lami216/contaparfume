import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {managementInputFor} from '../app/perfume-management.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup,stringifyBackup} from '../lib/backup.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db,wh='w';
 await db.collection('warehouses').insertMany([{_id:wh,name:'Synthetic main',isSalesDefault:true},{_id:'other',name:'Synthetic other'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([
  {id:'full',sku:'1',name:'Synthetic perfume',perfumeForm:'full',stocks:{w:1},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500},
  {id:'b10',sku:'2',name:'Synthetic10ml glass',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:20},openingCost:2,lastPurchaseCost:2,pieceCost:2},
  {id:'b5',sku:'3',name:'Synthetic5ml glass',perfumeForm:'bottle',decantSizeMl:5,stocks:{w:20},openingCost:1,lastPurchaseCost:1,pieceCost:1},
 ]);
 const run=body=>db.transaction(session=>execute(db,session,body));
 await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:wh,volumeMl:100,priceBasisMl:10,salePrice:200});
 const product=await db.collection('products').findOne({perfumeForm:'decant'}),p=product.id,lot=product.perfumeLots[0].id;
 const doc=id=>db.collection('documents').findOne({id}),get=()=>db.collection('products').findOne({id:p});
 const sale=(quantity=1,more={})=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:p,bottleProductId:'b10',quantity,unitPrice:200,...more}]});
 const historicSale=await sale(),historicDocument=await doc(historicSale);
 const count=(actualQuantity,more={})=>run({type:'perfume-lot-correct.post',decantProductId:p,lotId:lot,warehouseId:wh,actualQuantity,reason:'Synthetic quantity correction',...more});
 const consume=(quantity,more={})=>run({type:'perfume-lot-consume.post',decantProductId:p,lotId:lot,warehouseId:wh,quantity,reason:'Synthetic physical loss',reasonCode:'waste',...more});
 const report=(type='overview',extra={})=>buildReport(db,parseReportFilters(new URL('http://localhost/api/reports?'+new URLSearchParams({type,allTime:'true',unpaged:'true',...extra}))));
 const money=()=>Promise.all(['paymentAccounts','financialMovements','parties'].map(name=>db.collection(name).find().sort({id:1}).toArray()));
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts','parties','counters','auditEvents','commandReceipts','productCategories','appSettings'].map(name=>db.collection(name).find().sort({id:1,_id:1}).toArray()));
 return{db,run,p,lot,wh,doc,get,sale,historicSale,historicDocument,count,consume,report,money,snapshot};
}
function financialSummary(summary){return Object.fromEntries(Object.entries(summary).filter(([key])=>!['currentInventoryValue','inventoryValue'].includes(key)));}
async function noFinancialReclassification(f,before,oldMoney){
 const after=await f.report();assert.deepEqual(financialSummary(after.summary),financialSummary(before.summary));
 assert.deepEqual(await f.money(),oldMoney);assert.deepEqual(await f.doc(f.historicSale),f.historicDocument);
 assert.equal((await f.report('profit')).summary.inventoryLoss,0);assert.equal((await f.report('profit')).summary.inventoryGain,0);
 return after;
}

for(const actual of [95,80,0,90.125])test(`new liquid quantity correction to${actual}ml changes valuation only at saved cost and preserves reports/COGS/cash`,async t=>{
 const f=await fixture(t),before=await f.report(),money=await f.money(),id=await f.count(actual,{inventoryLoss:999,inventoryGain:999,unitCost:999,perfumeStockTreatment:'legacy-reconciliation'}),d=await f.doc(id),p=await f.get(),delta=actual-90;
 assert.equal(d.perfumeStockTreatment,'quantity-correction');assert.equal(d.inventoryLoss,0);assert.equal(d.inventoryGain,0);assert.equal(d.stockDelta,delta);assert.equal(d.bookValueBefore,900);assert.equal(d.bookValueAfter,actual*10);
 assert.equal(p.stocks.w,actual);assert.equal(p.perfumeLots[0].remainingQuantity,actual);assert.equal(p.perfumeLots[0].liquidUnitCost,10);assert.equal(p.perfumeLots[0].landedUnitCost,10);
 assert.ok(d.lines.every(line=>Number(line.inventoryLoss??0)===0&&Number(line.inventoryGain??0)===0));
 const after=await noFinancialReclassification(f,before,money);assert.equal(after.summary.currentInventoryValue,before.summary.currentInventoryValue+delta*10);assert.equal(after.summary.netOperatingResult,98);
 const stock=await f.report('stock',{productId:f.p});assert.equal(stock.summary.netChange,actual);const row=stock.rows.find(row=>row.documentId===id);assert.ok(row);assert.equal(row.change,delta);assert.equal(row.after,actual);assert.equal(row.unit,'مل');
 for(const extra of [{productId:f.p},{categoryId:'system:perfume:decants'}]){const report=await f.report('profit',extra);assert.equal(report.summary.inventoryLoss,0);assert.equal(report.summary.inventoryGain,0);assert.deepEqual(report.inventoryEffects,{loss:[],gain:[]});}
});

test('fixed lot cost remains the authority for future sales after correction and after catalog reference cost changes',async t=>{
 const f=await fixture(t),before=await f.report();await f.db.collection('products').updateOne({id:f.p},{$set:{pieceCost:999,lastPurchaseCost:999}});
 await f.count(95);const sale=await f.sale(1,{bottleProductId:'b5',unitPrice:100}),d=await f.doc(sale),p=await f.get();
 assert.equal(d.lines[0].liquidQuantityMl,5);assert.equal(d.lines[0].costAtSale,51);assert.equal(d.lines[0].grossProfit,49);assert.equal(p.perfumeLots[0].liquidUnitCost,10);assert.equal(p.stocks.w,90);
 const after=await f.report();assert.equal(after.summary.salesCost,before.summary.salesCost+51);assert.equal(after.summary.salesProfit,before.summary.salesProfit+49);assert.equal(after.summary.inventoryLoss,0);assert.equal(after.summary.inventoryGain,0);assert.deepEqual(await f.doc(f.historicSale),f.historicDocument);
});

test('correction after full sale creates saved-cost stock without inventory gain and subsequent sale keeps that cost',async t=>{
 const f=await fixture(t);await f.sale(9);let before=await f.report();assert.equal((await f.get()).stocks.w,0);
 const money=await f.money();await f.count(5);let after=await f.report();assert.equal(after.summary.currentInventoryValue,before.summary.currentInventoryValue+50);assert.equal(after.summary.inventoryGain,0);assert.deepEqual(await f.money(),money);
 const sold=await f.sale(1,{bottleProductId:'b5',unitPrice:100});assert.equal((await f.doc(sold)).lines[0].costAtSale,51);assert.equal((await f.get()).stocks.w,0);after=await f.report();assert.equal(after.summary.salesCost,1071);assert.equal(after.summary.netOperatingResult,1029);
});

test('consumption still recognizes physical liquid loss at saved cost and its void restores value and profit once',async t=>{
 const f=await fixture(t),before=await f.report(),money=await f.money(),id=await f.consume(5),d=await f.doc(id);
 assert.equal(d.perfumeStockOperationType,'consumption');assert.equal(d.inventoryLoss,50);assert.equal(Number(d.inventoryGain??0),0);assert.notEqual(d.perfumeStockTreatment,'quantity-correction');
 const after=await f.report();assert.equal(after.summary.currentInventoryValue,before.summary.currentInventoryValue-50);assert.equal(after.summary.inventoryLoss,50);assert.equal(after.summary.netOperatingResult,before.summary.netOperatingResult-50);assert.equal(after.inventoryEffects.loss[0].documentId,id);assert.deepEqual(await f.money(),money);
 const filtered=await f.report('profit',{categoryId:'system:perfume:decants'});assert.equal(filtered.summary.inventoryLoss,50);
 await f.run({type:'perfume-management.void',documentId:id,expectedRevision:0});assert.deepEqual((await f.report()).summary,before.summary);assert.deepEqual(await f.doc(f.historicSale),f.historicDocument);
});

test('quantity-correction marker excludes stale financial fields while unmarked legacy loss/gain remain intact through backup and reversals',async t=>{
 const f=await fixture(t),base=await f.report(),oldLoss=await f.count(80),oldGain=await f.count(85);
 for(const[id,loss,gain]of [[oldLoss,100,0],[oldGain,0,50]]){const d=await f.doc(id);await f.db.collection('documents').updateOne({id},{$unset:{perfumeStockTreatment:1},$set:{inventoryLoss:loss,inventoryGain:gain,lines:d.lines.map(line=>({...line,inventoryLoss:loss,inventoryGain:gain}))}});}
 const oldSnapshots=[await f.doc(oldLoss),await f.doc(oldGain)],newId=await f.count(88),fresh=await f.doc(newId);
 await f.db.collection('documents').updateOne({id:newId},{$set:{inventoryLoss:999,inventoryGain:888,lines:fresh.lines.map(line=>({...line,inventoryLoss:999,inventoryGain:888}))}});
 let report=await f.report('profit');assert.equal(report.summary.inventoryLoss,100);assert.equal(report.summary.inventoryGain,50);assert.deepEqual(report.inventoryEffects.loss.map(row=>row.documentId),[oldLoss]);assert.deepEqual(report.inventoryEffects.gain.map(row=>row.documentId),[oldGain]);
 const backup=parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));await f.db.transaction(session=>restoreNativeBackup(f.db,backup,session));
 assert.equal((await f.doc(newId)).perfumeStockTreatment,'quantity-correction');assert.deepEqual([await f.doc(oldLoss),await f.doc(oldGain)],oldSnapshots);report=await f.report('profit');assert.equal(report.summary.inventoryLoss,100);assert.equal(report.summary.inventoryGain,50);
 await f.run({type:'perfume-management.void',documentId:newId,expectedRevision:0});assert.equal((await f.get()).stocks.w,85);assert.equal((await f.report()).summary.inventoryLoss,100);assert.equal((await f.report()).summary.inventoryGain,50);
 await f.run({type:'perfume-management.void',documentId:oldGain,expectedRevision:0});assert.equal((await f.get()).stocks.w,80);assert.equal((await f.report()).summary.inventoryGain,0);
 await f.run({type:'perfume-management.void',documentId:oldLoss,expectedRevision:0});assert.equal((await f.get()).stocks.w,90);assert.deepEqual((await f.report()).summary,base.summary);assert.deepEqual(await f.doc(f.historicSale),f.historicDocument);
});

test('new correction edit and cancellation preserve fixed costs, history and zero financial effect',async t=>{
 const f=await fixture(t),before=await f.report(),money=await f.money(),first=await f.count(95),d=await f.doc(first);
 const revised=await f.run({type:'perfume-management.update',documentId:first,expectedRevision:0,...managementInputFor(d,[]),actualQuantity:85}),updated=await f.doc(revised);
 assert.equal(updated.perfumeStockTreatment,'quantity-correction');assert.equal(updated.replacesDocumentId,first);assert.equal((await f.doc(first)).status,'voided');assert.equal(updated.inventoryLoss,0);assert.equal(updated.inventoryGain,0);assert.equal((await f.get()).perfumeLots[0].liquidUnitCost,10);
 const after=await noFinancialReclassification(f,before,money);assert.equal(after.summary.currentInventoryValue,before.summary.currentInventoryValue-50);
 await f.run({type:'perfume-management.void',documentId:revised,expectedRevision:1});assert.equal((await f.get()).stocks.w,90);assert.deepEqual((await f.report()).summary,before.summary);
});

test('failed quantity correction rolls back stock, lot metadata, reports, financial history and document counters',async t=>{
 const f=await fixture(t),before=await f.snapshot(),report=await f.report();
 f.db.native.exec(`CREATE TRIGGER fail_quantity_correction BEFORE INSERT ON documents WHEN json_extract(NEW.data_json,'$.perfumeStockTreatment')='quantity-correction' BEGIN SELECT RAISE(ABORT,'synthetic correction posting failure'); END`);
 await assert.rejects(f.count(80),/synthetic correction posting failure/);assert.deepEqual(await f.snapshot(),before);assert.deepEqual((await f.report()).summary,report.summary);
 f.db.native.exec('DROP TRIGGER fail_quantity_correction');for(const actual of [-1,0.0001,'bad',90]){const snapshot=await f.snapshot();await assert.rejects(f.count(actual));assert.deepEqual(await f.snapshot(),snapshot);}
});

test('neutral edits keep historical loss and gain in their original report period with current audit timestamps',async t=>{
 const f=await fixture(t),historicalAt='2001-07-15T10:30:00.000Z',today=new Date().toISOString().slice(0,10);
 const period=(day)=>f.report('profit',{allTime:'false',from:day,to:day});
 for(const [actual,loss,gain,businessDate] of [[80,100,0,'2001-07-14'],[95,0,50,undefined]]){
  const id=await f.count(actual),fresh=await f.doc(id),set={occurredAt:historicalAt,inventoryLoss:loss,inventoryGain:gain,lines:fresh.lines.map(line=>({...line,inventoryLoss:loss,inventoryGain:gain}))};
  if(businessDate!==undefined)set.businessDate=businessDate;
  await f.db.collection('documents').updateOne({id},{$unset:{perfumeStockTreatment:1,...(businessDate===undefined?{businessDate:1}:{})},$set:set});
  await f.db.collection('stockMovements').updateMany({documentId:id},{$set:{occurredAt:historicalAt}});
  const original=await f.doc(id),historicBefore=await period('2001-07-15'),currentBefore=await period(today),money=await f.money(),started=Date.now();
  assert.equal(historicBefore.summary.inventoryLoss,loss);assert.equal(historicBefore.summary.inventoryGain,gain);assert.equal(currentBefore.summary.inventoryLoss,0);assert.equal(currentBefore.summary.inventoryGain,0);
  const revised=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(original,[]),note:'Synthetic historical note edit'}),next=await f.doc(revised),source=await f.doc(id);
  assert.equal(next.occurredAt,historicalAt);assert.equal(Object.hasOwn(next,'businessDate'),businessDate!==undefined);assert.equal(next.businessDate,businessDate);assert.ok(Date.parse(next.updatedAt)>=started);assert.equal(next.perfumeStockTreatment,undefined);
  assert.deepEqual(next.lines.map(line=>[line.quantity,line.unitPrice,line.inventoryLoss,line.inventoryGain]),original.lines.map(line=>[line.quantity,line.unitPrice,line.inventoryLoss,line.inventoryGain]));
  for(const key of ['occurredAt','businessDate','inventoryLoss','inventoryGain','lines','perfumeLotBefore','perfumeLotAfter'])assert.deepEqual(source[key],original[key],key);
  const movements=await f.db.collection('stockMovements').find({documentId:revised}).toArray();assert.ok(movements.length>0);for(const movement of movements){assert.equal(movement.occurredAt,historicalAt);assert.ok(Date.parse(movement.createdAt)>=started);}
  const historicAfter=await period('2001-07-15'),currentAfter=await period(today);assert.deepEqual(historicAfter.summary,historicBefore.summary);assert.deepEqual(currentAfter.summary,currentBefore.summary);assert.deepEqual(await f.money(),money);
  assert.deepEqual(historicAfter.inventoryEffects.loss.map(row=>row.documentId),loss?[revised]:[]);assert.deepEqual(historicAfter.inventoryEffects.gain.map(row=>row.documentId),gain?[revised]:[]);
  await f.run({type:'perfume-management.void',documentId:revised,expectedRevision:1});assert.equal((await f.get()).stocks.w,90);
 }
});
