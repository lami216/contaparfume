import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute,POST} from '../app/api/command/route.ts';
import {createSession} from '../lib/auth.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {managementInputFor} from '../app/perfume-management.ts';
import {groupPerfumeBatches,perfumeBatchQuantity,perfumeBatchStatus} from '../app/perfume-batch-status.ts';

async function fixture(t,{legacy=false}={}){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 const previous=process.env.ALKARNA_USER_DATA;process.env.ALKARNA_USER_DATA=h.directory;t.after(()=>{if(previous===undefined)delete process.env.ALKARNA_USER_DATA;else process.env.ALKARNA_USER_DATA=previous});
 await db.collection('warehouses').insertMany([{_id:'w',name:'Synthetic source',isSalesDefault:true},{_id:'other',name:'Synthetic second'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([{id:'full',sku:'1',name:'Synthetic perfume',perfumeForm:'full',stocks:{w:4,other:1},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500},{id:'b',sku:'2',name:'Synthetic 10ml bottle',perfumeForm:'bottle',decantSizeMl:10,openingCost:10,lastPurchaseCost:10,stocks:{w:30,other:10}}]);
 const run=body=>db.transaction(session=>execute(db,session,body));
 const split=()=>run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',...(legacy?{divisionsCount:10}:{volumeMl:100,priceBasisMl:10}),salePrice:200});
 const source=await split(),get=()=>db.collection('products').findOne({perfumeForm:'decant',isArchived:{$ne:true}}),p=await get(),productId=p.id,lotId=p.perfumeLots[0].id;
 const input={decantProductId:productId,lotId,warehouseId:'w',reason:'Synthetic quantity correction'};
 const correct=(actualQuantity,extra={})=>run({type:'perfume-lot-correct.post',...input,actualQuantity,...extra});
 const sale=(quantity=2)=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId,quantity,bottleProductId:'b',unitPrice:200}]});
 const doc=id=>db.collection('documents').findOne({id}),cancel=documentId=>run({type:'perfume-management.void',documentId});
 const snapshot=()=>Promise.all(['products','warehouses','parties','documents','stockMovements','financialMovements','paymentAccounts','counters','auditEvents','commandReceipts'].map(name=>db.collection(name).find().toArray()));
 const report=(type='overview')=>buildReport(db,parseReportFilters(new URL('http://local/api/reports?type='+type+'&allTime=true')));
 const post=async(body,key,user='manager')=>{const origin='http://127.0.0.1:3229',token=createSession({principalType:'user',userId:user}),response=await POST(new Request(origin+'/api/command',{method:'POST',headers:{origin,host:'127.0.0.1:3229',cookie:'conta_session='+token,'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()}};
 return{h,db,run,split,source,get,productId,lotId,input,correct,sale,doc,cancel,snapshot,report,post};
}

test('fresh ml quantity corrections increase, decrease, and close stock at fixed cost without profit, loss, or cash',async t=>{
 for(const actual of [112.345,75,0])await t.test('actual '+actual,async t=>{
  const f=await fixture(t),before=(await f.report()).summary,finance=await f.db.collection('financialMovements').find().toArray();
  const id=await f.correct(actual,{perfumeStockTreatment:'legacy-reconciliation',inventoryGain:999,inventoryLoss:999,unitCost:1}),d=await f.doc(id),p=await f.get(),lot=p.perfumeLots[0];
  assert.equal(d.perfumeStockTreatment,'quantity-correction');assert.equal(d.stockDelta,Math.round((actual-100)*1000)/1000);assert.equal(d.inventoryLoss,0);assert.equal(d.inventoryGain,0);
  assert.equal(d.bookValueBefore,1000);assert.equal(d.bookValueAfter,actual*10);assert.equal(d.lines[0].unitPrice,10);assert.equal(d.lines[0].inventoryLoss,0);assert.equal(d.lines[0].inventoryGain,0);
  assert.equal(lot.liquidUnitCost,10);assert.equal(lot.landedUnitCost,10);assert.equal(lot.originalQuantity,100);assert.equal(lot.remainingQuantity,actual);assert.equal(lot.stocks.w,actual);assert.equal(p.stocks.w,actual);
  assert.deepEqual(await f.db.collection('financialMovements').find().toArray(),finance);const after=(await f.report()).summary;
  for(const key of ['sales','salesCost','salesProfit','inventoryLoss','inventoryGain','netOperatingResult','currentAccountsBalance'])assert.equal(after[key],before[key],key);
  assert(Math.abs((after.currentInventoryValue-before.currentInventoryValue)-(actual-100)*10)<1e-8);
  await f.cancel(id);assert.equal((await f.get()).stocks.w,100);assert.equal((await f.report()).summary.currentInventoryValue,before.currentInventoryValue);
 });
});

test('correction after sale preserves saved COGS and profit, while subsequent sales and consumption use the same authoritative ml cost',async t=>{
 const f=await fixture(t),sale=await f.sale(),historic=await f.doc(sale);assert.equal(historic.lines[0].costAtSale,110);assert.equal(historic.lines[0].grossProfit,180);
 await f.db.collection('products').updateOne({id:f.productId},{$set:{pieceCost:999,lastPurchaseCost:999}});
 const correction=await f.correct(90),p=await f.get();assert.equal(p.perfumeLots[0].liquidUnitCost,10);assert.deepEqual(await f.doc(sale),historic);
 const sales=(await f.report('sales')).summary;assert.equal(sales.netSales,400);assert.equal(sales.cost,220);assert.equal(sales.profit,180);
 const remainder=await f.run({type:'perfume-remainder-sale.post',productId:f.productId,lotId:f.lotId,warehouseId:'w',quantityMl:5,totalPrice:150,paymentMethod:'cash'});assert.equal((await f.doc(remainder)).lines[0].costAtSale,50);
 const consumed=await f.run({type:'perfume-lot-consume.post',...f.input,quantity:3,reasonCode:'samples'}),summary=(await f.report()).summary;
 assert.equal(summary.sales,550);assert.equal(summary.salesCost,270);assert.equal(summary.salesProfit,280);assert.equal(summary.inventoryLoss,30);assert.equal(summary.inventoryGain,0);assert.equal(summary.netOperatingResult,250);assert.equal(summary.currentAccountsBalance,10550);
 await f.cancel(consumed);await f.run({type:'decant-sale.void',documentId:remainder});await f.cancel(correction);await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks.w,100);assert.equal((await f.report()).summary.currentAccountsBalance,10000);
});

test('same-context correction edits retain fixed cost through linked revisions and cancellation restores the original quantity',async t=>{
 const f=await fixture(t),id=await f.correct(110),old=await f.doc(id);await f.db.collection('products').updateOne({id:f.productId},{$set:{pieceCost:900}});
 const replacement=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(old,[]),actualQuantity:95}),d=await f.doc(replacement),prior=await f.doc(id);
 assert.notEqual(replacement,id);assert.equal(prior.status,'voided');assert.equal(prior.replacedByDocumentId,replacement);assert.deepEqual(prior.lines,old.lines);assert.equal(d.replacesDocumentId,id);assert.equal(d.revision,1);assert.equal(d.perfumeStockTreatment,'quantity-correction');assert.equal(d.lines[0].unitPrice,10);assert.equal(d.bookValueAfter,950);assert.equal((await f.get()).stocks.w,95);
 assert.equal((await f.report()).summary.inventoryLoss,0);assert.equal((await f.report()).summary.inventoryGain,0);
 const stable=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.update',documentId:replacement,expectedRevision:0,...f.input,actualQuantity:80}),/تغيرت/);assert.deepEqual(await f.snapshot(),stable);
 await f.cancel(replacement);assert.equal((await f.get()).stocks.w,100);assert.equal((await f.get()).perfumeLots[0].liquidUnitCost,10);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
});

test('multiwarehouse decimal corrections affect only their selected stock and keep global lot/product quantities consistent',async t=>{
 const f=await fixture(t);await f.run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'other',lines:[{productId:f.productId,quantity:20}]});
 const one=await f.correct(20.125,{warehouseId:'other'}),p=await f.get();assert.equal(p.stocks.w,80);assert.equal(p.stocks.other,20.125);assert.equal(p.perfumeLots[0].remainingQuantity,100.125);assert.equal(perfumeBatchQuantity(p.perfumeLots[0]),100.125);
 const two=await f.correct(0),after=await f.get();assert.equal(after.stocks.w,0);assert.equal(after.stocks.other,20.125);assert.equal(after.perfumeLots[0].remainingQuantity,20.125);assert.equal(perfumeBatchStatus(after.perfumeLots[0]),'active');assert.equal(after.perfumeLots[0].liquidUnitCost,10);
 await f.cancel(two);await f.cancel(one);const restored=await f.get();assert.equal(restored.stocks.w,80);assert.equal(restored.stocks.other,20);assert.equal(restored.perfumeLots[0].remainingQuantity,100);
});

test('negative, excessive precision, malformed quantities and invalid context reject atomically',async t=>{
 const f=await fixture(t),before=await f.snapshot();
 for(const actual of [-1,NaN,Infinity,'',false,null,{},[],1.0001]){await assert.rejects(f.correct(actual),'invalid '+String(actual));assert.deepEqual(await f.snapshot(),before);}
 for(const extra of [{warehouseId:'missing'},{lotId:'missing'},{decantProductId:'missing'},{reason:''}]){await assert.rejects(f.correct(90,extra));assert.deepEqual(await f.snapshot(),before);}
});

test('inconsistent lot stock totals cannot be hidden by recording a correction',async t=>{
 const f=await fixture(t),p=await f.get(),lots=structuredClone(p.perfumeLots);lots[0].remainingQuantity=99;await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeLots:lots}});const before=await f.snapshot();
 await assert.rejects(f.correct(90),/يطابق/);assert.deepEqual(await f.snapshot(),before);
 await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeLots:p.perfumeLots,'stocks.w':99}});const mismatch=await f.snapshot();await assert.rejects(f.correct(90),/يطابق/);assert.deepEqual(await f.snapshot(),mismatch);
});

test('later absolute counts are source-linked barriers even with earlier business dates and become reversible after cancellation',async t=>{
 const f=await fixture(t),one=await f.correct(110),two=await f.correct(105);await f.db.collection('documents').updateOne({id:two},{$set:{occurredAt:'2000-01-01T00:00:00Z'}});const stable=await f.snapshot();
 await assert.rejects(f.cancel(one),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===two&&d.number));assert.deepEqual(await f.snapshot(),stable);
 await f.cancel(two);await f.cancel(one);assert.equal((await f.get()).stocks.w,100);
});

test('unmarked historical ml counts retain their financial snapshots on neutral edits and require cancellation for quantity changes',async t=>{
 const f=await fixture(t),id=await f.correct(110),fresh=await f.doc(id);await f.db.collection('documents').updateOne({id},{$unset:{perfumeStockTreatment:1},$set:{inventoryGain:100,lines:fresh.lines.map(l=>({...l,inventoryGain:100}))}});
 const old=await f.doc(id);assert.equal((await f.report()).summary.inventoryGain,100);
 const replacement=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(old,[]),note:'Historical header edit'}),d=await f.doc(replacement);
 assert.equal(d.perfumeStockTreatment,undefined);assert.equal(d.inventoryGain,100);assert.equal(d.inventoryLoss,old.inventoryLoss);assert.equal(d.bookValueBefore,old.bookValueBefore);assert.equal(d.bookValueAfter,old.bookValueAfter);assert.deepEqual(d.lines.map(l=>[l.quantity,l.unitPrice,l.inventoryLoss,l.inventoryGain]),old.lines.map(l=>[l.quantity,l.unitPrice,l.inventoryLoss,l.inventoryGain]));assert.equal((await f.report()).summary.inventoryGain,100);
 const before=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.update',documentId:replacement,expectedRevision:1,...managementInputFor(d,[]),actualQuantity:115}),/ألغ|إلغاء/);assert.deepEqual(await f.snapshot(),before);
 await f.cancel(replacement);assert.equal((await f.get()).stocks.w,100);assert.equal((await f.report()).summary.inventoryGain,0);
});

test('fresh legacy piece corrections retain unit cost and may reach zero without changing past COGS or posting loss',async t=>{
 const f=await fixture(t,{legacy:true}),original=(await f.get()).perfumeLots[0].liquidUnitCost,id=await f.correct(12),d=await f.doc(id),p=await f.get();
 assert.equal(d.perfumeStockTreatment,'quantity-correction');assert.equal(p.perfumeLots[0].liquidUnitCost,original);assert.equal(d.inventoryLoss,0);assert.equal(d.inventoryGain,0);assert.equal(d.bookValueBefore,1000);assert.equal(d.bookValueAfter,1200);
 await f.cancel(id);const zero=await f.correct(0);assert.equal((await f.get()).stocks.w,0);assert.equal((await f.report()).summary.inventoryLoss,0);await f.cancel(zero);assert.equal((await f.get()).stocks.w,10);
});

test('historical unmarked piece yield retains its old recalibrated cost and book value on a neutral linked edit',async t=>{
 const f=await fixture(t,{legacy:true}),id=await f.correct(12),fresh=await f.doc(id),p=await f.get(),legacyCost=1000/12,legacyLot={...p.perfumeLots[0],originalQuantity:12,liquidUnitCost:legacyCost,landedUnitCost:legacyCost};
 await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeLots:[legacyLot]}});
 await f.db.collection('documents').updateOne({id},{$unset:{perfumeStockTreatment:1,quantityUnit:1},$set:{perfumeStockOperationType:'yield-correction',perfumeLotAfter:legacyLot,bookValueBefore:1000,bookValueAfter:1000,lines:fresh.lines.map(line=>({...line,unitPrice:legacyCost}))}});
 const old=await f.doc(id),before=(await f.report()).summary,replacement=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(old,[]),reason:'Historical note update'}),d=await f.doc(replacement),after=await f.get();
 assert.equal(d.perfumeStockTreatment,undefined);assert.equal(d.bookValueBefore,1000);assert.equal(d.bookValueAfter,1000);assert.equal(d.lines[0].unitPrice,legacyCost);assert.equal(after.perfumeLots[0].liquidUnitCost,legacyCost);assert.equal(after.perfumeLots[0].originalQuantity,12);assert.equal(after.stocks.w,12);
 for(const key of ['inventoryLoss','inventoryGain','currentInventoryValue','currentAccountsBalance','netOperatingResult'])assert.equal((await f.report()).summary[key],before[key],key);
 const stable=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.update',documentId:replacement,expectedRevision:1,...managementInputFor(d,[]),actualQuantity:11}),/ألغ|إلغاء/);assert.deepEqual(await f.snapshot(),stable);
 await f.cancel(replacement);const restored=await f.get();assert.equal(restored.stocks.w,10);assert.equal(restored.perfumeLots[0].liquidUnitCost,100);
});

test('fully bottled sale ends only its display state and cannot reopen over a newer positive lot',async t=>{
 const f=await fixture(t),sale=await f.sale(10),sold=await f.get(),lot=sold.perfumeLots[0];assert.equal(lot.remainingQuantity,0);assert.equal(lot.settledAt,undefined);assert.equal(perfumeBatchStatus(lot),'ended');assert.equal(groupPerfumeBatches([{product:sold,lot}]).length,0);assert.equal(groupPerfumeBatches([{product:sold,lot}],true)[0].batches.length,1);
 const next=await f.split(),before=await f.snapshot();await assert.rejects(f.run({type:'decant-sale.void',documentId:sale}),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===next));assert.deepEqual(await f.snapshot(),before);
 await f.cancel(next);await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks.w,100);assert.equal((await f.db.collection('products').findOne({id:'b'})).stocks.w,30);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
});

test('stock-neutral old bottled invoice payment edits preserve both lot quantities while actual reopening remains blocked',async t=>{
 const f=await fixture(t);await f.db.collection('paymentAccounts').insertOne({id:'bank',code:'bank',name:'Synthetic second account',isActive:true,balance:0,openingBalance:0});const sale=await f.sale(10),old=await f.doc(sale),next=await f.split(),before=await f.get();
 await f.run({type:'decant-sale.update',documentId:sale,expectedRevision:0,warehouseId:'w',paymentMethod:'bank',lines:[{productId:f.productId,quantity:10,bottleProductId:'b',unitPrice:200}]});const after=await f.get(),edited=await f.doc(sale);
 assert.deepEqual(after.perfumeLots,before.perfumeLots);assert.deepEqual(after.stocks,before.stocks);assert.equal(edited.lines[0].costAtSale,old.lines[0].costAtSale);assert.equal(edited.lines[0].grossProfit,old.lines[0].grossProfit);assert.deepEqual(edited.lines[0].perfumeAllocations,old.lines[0].perfumeAllocations);assert.equal(edited.revision,1);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'bank'})).balance,2000);
 const stable=await f.snapshot();for(const body of [{type:'decant-sale.void',documentId:sale},{type:'decant-sale.update',documentId:sale,expectedRevision:1,exactStockReplay:true,warehouseId:'w',paymentMethod:'bank',lines:[{productId:f.productId,quantity:9,bottleProductId:'b',unitPrice:200}]}]){await assert.rejects(f.run(body),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===next));assert.deepEqual(await f.snapshot(),stable);}
 const moved=await f.run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'other',lines:[{productId:f.productId,quantity:100}]}),movedSnapshot=await f.snapshot();await assert.rejects(f.run({type:'decant-sale.update',documentId:sale,expectedRevision:1,warehouseId:'other',paymentMethod:'bank',lines:[{productId:f.productId,quantity:10,bottleProductId:'b',unitPrice:200}]}),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===next));assert.deepEqual(await f.snapshot(),movedSnapshot);await f.run({type:'transfer.void',documentId:moved});
 await f.cancel(next);await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks.w,100);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'bank'})).balance,0);
});

test('new correction cannot reopen a globally exhausted lot while a newer same-source lot has stock; API retry works only after dependent cancellation',async t=>{
 for(const legacy of [false,true])await t.test(legacy?'legacy piece':'millilitres',async t=>{
  const f=await fixture(t,{legacy});await f.db.collection('users').insertOne({id:'manager',username:'manager',name:'Synthetic manager',isActive:true,permissions:['perfume.divisions.manage']});
  const sale=await f.sale(10),historicSale=await f.doc(sale),next=await f.split(),nextDoc=await f.doc(next),before=await f.snapshot(),body={type:'perfume-lot-correct.post',...f.input,actualQuantity:10};
  assert.equal((await f.get()).perfumeLots.find(l=>l.id===f.lotId).remainingQuantity,0);
  const blocked=await f.post(body,'reopen-old-lot');assert.equal(blocked.status,409,JSON.stringify(blocked));assert.equal(blocked.body.code,'PERFUME_OPERATION_BLOCKED');assert(blocked.body.error.startsWith('هذا التصحيح يعيد فتح دفعة قديمة بينما توجد دفعة أحدث بها رصيد. عالج الدفعة الأحدث أولًا:'));assert(blocked.body.dependencies.some(d=>d.documentId===next&&d.number===nextDoc.number));assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'reopen-old-lot'}),null);
  await f.cancel(next);const baseline=(await f.report()).summary,finance=await f.db.collection('financialMovements').find().toArray(),retry=await f.post(body,'reopen-old-lot');assert.equal(retry.status,200,JSON.stringify(retry));const committed=await f.snapshot();assert.deepEqual(await f.post(body,'reopen-old-lot'),retry);assert.deepEqual(await f.snapshot(),committed);
  const product=await f.get(),lot=product.perfumeLots.find(l=>l.id===f.lotId),correction=await f.doc(retry.body.id),summary=(await f.report()).summary;assert.equal(product.stocks.w,10);assert.equal(lot.remainingQuantity,10);assert.equal(lot.liquidUnitCost,legacy?100:10);assert.equal(correction.perfumeStockTreatment,'quantity-correction');assert.equal(correction.inventoryGain,0);assert.equal(correction.inventoryLoss,0);assert.deepEqual(await f.doc(sale),historicSale);assert.deepEqual(await f.db.collection('financialMovements').find().toArray(),finance);
  for(const key of ['sales','salesCost','salesProfit','inventoryLoss','inventoryGain','netOperatingResult','currentAccountsBalance'])assert.equal(summary[key],baseline[key],key);
  await f.cancel(retry.body.id);await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks.w,legacy?10:100);
 });
});

test('actual POST correction failure rolls back stock/document/receipt and same-key retry plus linked update/void remain idempotent',async t=>{
 const f=await fixture(t);await f.db.collection('users').insertMany([{id:'manager',username:'manager',name:'Synthetic manager',isActive:true,permissions:['perfume.divisions.manage']},{id:'viewer',username:'viewer',name:'Synthetic viewer',isActive:true,permissions:['products.view']}]);
 const body={type:'perfume-lot-correct.post',...f.input,actualQuantity:110},before=await f.snapshot();assert.equal((await f.post(body,'denied','viewer')).status,403);assert.deepEqual(await f.snapshot(),before);
 f.db.native.exec("CREATE TRIGGER correction_failure BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'PRIVATE_SYNTHETIC_CORRECTION'); END");const failure=await f.post(body,'correction');assert.equal(failure.status,500);assert.deepEqual(failure.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'correction'}),null);f.db.native.exec('DROP TRIGGER correction_failure');
 const first=await f.post(body,'correction');assert.equal(first.status,200,JSON.stringify(first));const committed=await f.snapshot();assert.deepEqual(await f.post(body,'correction'),first);assert.deepEqual(await f.snapshot(),committed);
 const edit={type:'perfume-management.update',documentId:first.body.id,expectedRevision:0,...f.input,actualQuantity:95};f.db.native.exec("CREATE TRIGGER correction_edit_failure BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'PRIVATE_SYNTHETIC_EDIT'); END");const failedEdit=await f.post(edit,'edit');assert.equal(failedEdit.status,500);assert.deepEqual(failedEdit.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),committed);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'edit'}),null);f.db.native.exec('DROP TRIGGER correction_edit_failure');
 const updated=await f.post(edit,'edit');assert.equal(updated.status,200,JSON.stringify(updated));const edited=await f.snapshot();assert.deepEqual(await f.post(edit,'edit'),updated);assert.deepEqual(await f.snapshot(),edited);
 const voidBody={type:'perfume-management.void',documentId:updated.body.id,expectedRevision:1};f.db.native.exec("CREATE TRIGGER correction_void_failure BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'PRIVATE_SYNTHETIC_VOID'); END");const failedVoid=await f.post(voidBody,'void');assert.equal(failedVoid.status,500);assert.deepEqual(failedVoid.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),edited);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'void'}),null);f.db.native.exec('DROP TRIGGER correction_void_failure');
 const canceled=await f.post(voidBody,'void');assert.equal(canceled.status,200,JSON.stringify(canceled));const voided=await f.snapshot();assert.deepEqual(await f.post(voidBody,'void'),canceled);assert.deepEqual(await f.snapshot(),voided);assert.equal((await f.get()).stocks.w,100);
});

test('actual POST sale void returns source-linked new-lot blocker, rolls back receipt, then succeeds with the identical key after dependent cancellation',async t=>{
 const f=await fixture(t);await f.db.collection('users').insertOne({id:'manager',username:'manager',name:'Synthetic manager',isActive:true,permissions:['perfume.divisions.manage','invoices.decant-sale.void']});const sale=await f.sale(10),next=await f.split(),before=await f.snapshot(),body={type:'decant-sale.void',documentId:sale};
 const blocked=await f.post(body,'retry-sale-void');assert.equal(blocked.status,409,JSON.stringify(blocked));assert.equal(blocked.body.code,'PERFUME_OPERATION_BLOCKED');assert(blocked.body.dependencies.some(d=>d.documentId===next));assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'retry-sale-void'}),null);
 await f.cancel(next);const retry=await f.post(body,'retry-sale-void');assert.equal(retry.status,200,JSON.stringify(retry));const committed=await f.snapshot();assert.deepEqual(await f.post(body,'retry-sale-void'),retry);assert.deepEqual(await f.snapshot(),committed);assert.equal((await f.get()).stocks.w,100);
});

test('batch presentation groups by source identity, preserves independent histories, and never mistakes selected-warehouse zero for global exhaustion',()=>{
 const lot=(id,sourceProductId,stocks,extra={})=>({id,sourceProductId,sourceProductName:'Same display name',originalQuantity:100,remainingQuantity:999,stocks,liquidUnitCost:10,landedUnitCost:10,bottleCost:0,decantSizeMl:null,createdAt:'2026-01-01',conversionDocumentId:'doc-'+id,...extra});
 const rows=[{lot:lot('one','a',{w:0,other:7.125})},{lot:lot('two','a',{w:0},{settledAt:'saved'})},{lot:lot('three','b',{w:4})},{lot:lot('four','a',{w:0},{recombinedAt:'saved',partialProductId:'historic'})},{lot:lot('five','a',{w:2},{settledAt:'stale-but-preserved'})},{lot:lot('six','a',{w:0})}],before=structuredClone(rows);
 const working=groupPerfumeBatches(rows);assert.deepEqual(working.map(g=>[g.sourceProductId,g.batches.map(b=>b.lot.id)]),[['a',['one','five']],['b',['three']]]);assert.strictEqual(working[0].batches[0],rows[0]);assert.equal(perfumeBatchQuantity(rows[0].lot),7.125);assert.equal(perfumeBatchStatus(rows[0].lot),'active');assert.equal(perfumeBatchStatus(rows[1].lot),'settled');assert.equal(perfumeBatchStatus(rows[3].lot),'recombined');assert.equal(perfumeBatchStatus(rows[5].lot),'ended');assert.equal(perfumeBatchStatus(rows[4].lot),'settled');assert.equal(groupPerfumeBatches(rows,true)[0].batches.length,5);assert.deepEqual(rows,before);
 const missing=[{lot:lot('missing-one','',{w:1})},{lot:lot('missing-two','',{w:2})}];assert.equal(groupPerfumeBatches(missing).length,2);
});

