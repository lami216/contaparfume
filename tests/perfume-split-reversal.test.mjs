import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';

async function setup(t,{legacy=false}={}) {
  const harness=await sqliteHarness();await harness.reset();t.after(()=>harness.close());const db=harness.db;
  await db.collection('warehouses').insertMany([{id:'w',name:'Main',isSalesDefault:true},{id:'w2',name:'Other'}]);
  await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',openingBalance:10000,balance:10000,isActive:true});
  await db.collection('products').insertMany([
    {id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{w:3},openingCost:1000,lastPurchaseCost:1000,pieceCost:1000,piecePrice:1500},
    {id:'bottle',sku:'2',name:'Bottle',perfumeForm:'bottle',stocks:{w:20},openingCost:5,lastPurchaseCost:5,pieceCost:5,decantSizeMl:10},
  ]);
  const run=body=>db.transaction(session=>execute(db,session,body));
  const split=await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',salePrice:150,...(legacy?{divisionsCount:9}:{volumeMl:100,priceBasisMl:10})});
  const original=await db.collection('documents').findOne({id:split});
  const p=original.decantProductId,lot=original.perfumeLotId;
  const product=()=>db.collection('products').findOne({id:p});
  // Historical generic sales are no longer accepted by today's POS. Seed their
  // persisted contract to test reversal of records produced by older releases.
  const oldSale=quantity=>db.transaction(async session=>{
    const current=await db.collection('products').findOne({id:p},{session}),batch=current.perfumeLots[0];
    const documentId='sale-'+crypto.randomUUID(),before=current.stocks.w,after=before-quantity;
    batch.remainingQuantity-=quantity;batch.stocks.w-=quantity;
    await db.collection('products').updateOne({id:p},{$set:{perfumeLots:current.perfumeLots,'stocks.w':after}},{session});
    await db.collection('documents').insertOne({id:documentId,number:'SAL-'+documentId,kind:'sale',status:'posted',warehouseId:'w',warehouseName:'Main',partyId:null,parentDocumentId:null,paymentMethod:'note',total:quantity*150,paidTotal:0,dueTotal:0,cashAmount:0,occurredAt:new Date().toISOString(),lines:[{id:'line-'+documentId,productId:p,description:'Old decant sale',quantity,unitPrice:150,lineTotal:quantity*150,costAtSale:batch.liquidUnitCost,perfumeAllocations:[{lotId:lot,quantity,unitCost:batch.liquidUnitCost,warehouseId:'w'}]}]},{session});
    await db.collection('stockMovements').insertOne({id:'mov-'+documentId,documentId,warehouseId:'w',productId:p,type:'sale',quantityDelta:-quantity,balanceBefore:before,balanceAfter:after,occurredAt:new Date().toISOString()},{session});
    return documentId;
  });
  const report=async()=>(await buildReport(db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=overview&allTime=true')))).summary;
  const voidSplit=()=>run({type:'perfume-management.void',documentId:split,expectedRevision:0});
  const snapshot=async()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts'].map(name=>db.collection(name).find().toArray()));
  return {db,run,oldSale,split,original,p,lot,product,report,voidSplit,snapshot};
}

test('untouched millilitre conversion cancels directly with exact stock/value restoration and no cash or profit',async t=>{
  const f=await setup(t),before=await f.report();
  await f.voidSplit();
  const after=await f.report(),p=await f.product();
  assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
  assert.equal(p.stocks.w,0);assert.equal(p.perfumeLots.length,0);assert.equal(p.isArchived,true);
  for(const key of ['currentInventoryValue','sales','salesProfit','inventoryLoss','inventoryGain','netOperatingResult','currentAccountsBalance'])assert.equal(after[key],before[key],key);
  assert.equal(await f.db.collection('financialMovements').countDocuments(),0);
  const cancelled=await f.db.collection('documents').findOne({id:f.split});
  assert.equal(cancelled.status,'voided');assert.deepEqual(cancelled.lines,f.original.lines);
  assert.equal(cancelled.perfumeSplitReversal.quantityRemoved,100);
  assert.equal(await f.db.collection('stockMovements').countDocuments({documentId:f.split}),4);
  const snapshot=await f.snapshot();await assert.rejects(f.voidSplit(),/ملغاة/);assert.deepEqual(await f.snapshot(),snapshot);
});

test('a live sale remains a dependency even when a count restores the apparent original volume',async t=>{
  const f=await setup(t);
  const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:f.p,quantity:1,fillMl:5,bottleProductId:'bottle',unitPrice:150}]});
  const count=await f.run({type:'perfume-lot-correct.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w',actualQuantity:100,reason:'Physical count'});
  assert.equal((await f.product()).stocks.w,100);
  const before=await f.snapshot();await assert.rejects(f.voidSplit(),/حركات لاحقة/);assert.deepEqual(await f.snapshot(),before);
  await f.run({type:'perfume-management.void',documentId:count});
  await f.run({type:'decant-sale.void',documentId:sale});await f.voidSplit();
  assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
});

test('another independent lot and its active sale remain intact when canceling an unused lot',async t=>{
  const f=await setup(t);
  const second=await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:150});
  const d=await f.db.collection('documents').findOne({id:second});
  await f.run({type:'perfume-management.void',documentId:f.split});
  const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:f.p,quantity:1,fillMl:5,bottleProductId:'bottle',unitPrice:150}]});
  const third=await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:150});
  const before=await f.report();
  await f.run({type:'perfume-management.void',documentId:third});
  const p=await f.product();assert.equal(p.perfumeLots.length,1);assert.equal(p.perfumeLots[0].id,d.perfumeLotId);assert.equal(p.stocks.w,95);
  assert.equal((await f.db.collection('documents').findOne({id:sale})).status,'posted');
  assert.equal((await f.report()).salesProfit,before.salesProfit);
});

test('legacy landed cost is compared as liquid plus glass without rewriting old invoice costs',async t=>{
  const f=await setup(t,{legacy:true}),p=await f.product(),original=f.original;
  const lot=p.perfumeLots[0];lot.liquidUnitCost=112;lot.bottleCost=150;lot.landedUnitCost=262;
  await f.db.collection('products').updateOne({id:f.p},{$set:{perfumeLots:[lot]}});
  const lines=structuredClone(original.lines);lines.find(line=>line.quantity>0).unitPrice=262;
  await f.db.collection('documents').updateOne({id:f.split},{$set:{lines},$unset:{perfumeLotAfter:'',perfumeManagementType:'',managementInput:''}});
  await f.voidSplit();const cancelled=await f.db.collection('documents').findOne({id:f.split});
  assert.equal(cancelled.perfumeSplitReversal.legacyLandedCost,true);assert.deepEqual(cancelled.lines,lines);
  assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
});

for(const salesFirst of [true,false])test(`old recombination reversal preserves canceled sale allocations (${salesFirst?'sales first':'return first'})`,async t=>{
  const f=await setup(t,{legacy:true});
  const sale=await f.oldSale(2);
  const partial=await f.run({type:'perfume-recombine.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w',salePrice:800});
  const returned=await f.db.collection('documents').findOne({partialProductId:partial});
  await f.db.collection('documents').updateOne({id:returned.id},{$unset:{perfumeLotBefore:'',perfumeLotAfter:'',perfumeManagementType:'',decantProductId:'',perfumeLotId:'',partialProductId:''}});
  if(salesFirst)await f.run({type:'sale.void',documentId:sale});
  await f.run({type:'perfume-management.void',documentId:returned.id});
  if(!salesFirst)await f.run({type:'sale.void',documentId:sale});
  const p=await f.product();assert.equal(p.stocks.w,9);assert.equal(p.perfumeLots[0].remainingQuantity,9);
  await f.voidSplit();assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
});

async function lostLegacyAllocations(t) {
  const f=await setup(t,{legacy:true});
  await f.db.collection('documents').updateOne({id:f.split},{$unset:{perfumeLotAfter:'',perfumeManagementType:'',managementInput:''}});
  const sale=await f.oldSale(2);
  await f.run({type:'sale.void',documentId:sale});
  const p=await f.product();p.perfumeLots[0].remainingQuantity=7;p.perfumeLots[0].stocks.w=7;
  await f.db.collection('products').updateOne({id:f.p},{$set:{perfumeLots:p.perfumeLots}});
  return {...f,sale};
}

test('documented old 9-visible/7-lot discrepancy cancels with evidence and unchanged financial records',async t=>{
  const f=await lostLegacyAllocations(t),before=await f.report();
  const money=await f.db.collection('financialMovements').find().toArray();
  await f.voidSplit();const cancelled=await f.db.collection('documents').findOne({id:f.split});
  assert.equal(cancelled.perfumeSplitReversal.recoveredCancelledQuantity,2);assert.equal(cancelled.perfumeSplitReversal.ledgerVerified,true);
  assert.deepEqual(await f.db.collection('financialMovements').find().toArray(),money);
  assert.equal((await f.report()).inventoryLoss,before.inventoryLoss);assert.equal((await f.report()).inventoryGain,before.inventoryGain);
  assert.equal((await f.product()).stocks.w,0);
});

for(const corruption of ['unreversed-movement','no-allocation','extra-visible-stock','active-partial-sale'])test(`ambiguous old discrepancy remains blocked atomically: ${corruption}`,async t=>{
  const f=await lostLegacyAllocations(t);
  if(corruption==='unreversed-movement')await f.db.collection('stockMovements').deleteOne({documentId:f.sale,type:'sale-void'});
  if(corruption==='no-allocation'){
    const sale=await f.db.collection('documents').findOne({id:f.sale});delete sale.lines[0].perfumeAllocations;
    await f.db.collection('documents').updateOne({id:f.sale},{$set:{lines:sale.lines}});
  }
  if(corruption==='extra-visible-stock')await f.db.collection('products').updateOne({id:f.p},{$set:{'stocks.w':10}});
  if(corruption==='active-partial-sale'){
    await f.db.collection('documents').insertMany([
      {id:'old-return',kind:'adjustment',status:'voided',perfumeConversionType:'perfume-recombine',lines:[{productId:f.p,quantity:-7},{productId:'partial',quantity:1}]},
      {id:'partial-sale',kind:'sale',status:'posted',lines:[{productId:'partial',quantity:1}]},
    ]);
  }
  const before=await f.snapshot();await assert.rejects(f.voidSplit(),/حركات لاحقة/);assert.deepEqual(await f.snapshot(),before);
});

test('a snapshot-protected return must be voided before its old sale; failed sale reversal is atomic',async t=>{
  const f=await setup(t,{legacy:true}),sale=await f.oldSale(2);
  const partial=await f.run({type:'perfume-recombine.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w',salePrice:800});
  const returned=await f.db.collection('documents').findOne({partialProductId:partial});
  const before=await f.snapshot();await assert.rejects(f.run({type:'sale.void',documentId:sale}),/حركات لاحقة/);
  assert.deepEqual(await f.snapshot(),before);
  await f.run({type:'perfume-management.void',documentId:returned.id});await f.run({type:'sale.void',documentId:sale});
  assert.equal((await f.product()).perfumeLots[0].remainingQuantity,9);await f.voidSplit();
});

test('an untouched legacy split can be canceled after unit migration without voiding the unit-definition document',async t=>{
  const f=await setup(t,{legacy:true});
  const migration=await f.run({type:'perfume-volume.migrate',decantProductId:f.p,legacyPortionMl:10});
  const before=await f.report();await f.voidSplit();
  assert.equal((await f.product()).stocks.w,0);assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
  assert.equal((await f.db.collection('documents').findOne({id:migration})).status,'posted');
  const cancelled=await f.db.collection('documents').findOne({id:f.split});
  assert.equal(cancelled.perfumeSplitReversal.quantityRemoved,90);assert.equal(cancelled.perfumeSplitReversal.unitConversionId,migration);
  assert.equal((await f.report()).currentInventoryValue,before.currentInventoryValue);
  const movement=await f.db.collection('stockMovements').findOne({documentId:f.split,type:'perfume-split-void-out'});
  assert.equal(movement.quantityDelta,-90);assert.equal(movement.quantityUnit,'ml');
});

test('voiding an old generic sale after migration restores ml in both the visible stock and lot, then permits split cancellation',async t=>{
  const f=await setup(t,{legacy:true}),sale=await f.oldSale(2);
  await f.run({type:'perfume-volume.migrate',decantProductId:f.p,legacyPortionMl:10});
  assert.equal((await f.product()).stocks.w,70);
  await f.run({type:'sale.void',documentId:sale});
  const p=await f.product();assert.equal(p.stocks.w,90);assert.equal(p.perfumeLots[0].remainingQuantity,90);
  const movement=await f.db.collection('stockMovements').findOne({documentId:sale,type:'sale-void'});
  assert.equal(movement.quantityDelta,20);assert.equal(movement.quantityUnit,'ml');
  await f.voidSplit();assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks.w,3);
});

test('an unproven migrated unit scale cannot bypass split reversal guards',async t=>{
  const f=await setup(t,{legacy:true});
  await f.run({type:'perfume-volume.migrate',decantProductId:f.p,legacyPortionMl:10});
  const p=await f.product();p.perfumeLots[0].legacyQuantityScaleMl=5;
  await f.db.collection('products').updateOne({id:f.p},{$set:{perfumeLots:p.perfumeLots}});
  const before=await f.snapshot();await assert.rejects(f.voidSplit(),/حركات لاحقة/);assert.deepEqual(await f.snapshot(),before);
});
