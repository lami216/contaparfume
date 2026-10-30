import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {execute as historicalCommand} from '../app/api/command/core-route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';
import {reversePerfumeLotTransfer} from '../app/perfume-stock-reconciliation.ts';

async function fixture(t){
 const h=await sqliteHarness();await h.reset();t.after(()=>h.close());const db=h.db;
 await db.collection('warehouses').insertMany([{id:'w',name:'Main',isSalesDefault:true},{id:'w2',name:'Other'},{id:'w3',name:'Third'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertOne({id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{w:3},openingCost:1000,lastPurchaseCost:1000,pieceCost:1000,piecePrice:1500});
 const run=b=>db.transaction(s=>execute(db,s,b));
 const split=await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',divisionsCount:10,salePrice:200});
 const doc=id=>db.collection('documents').findOne({id}),splitDoc=await doc(split),p=splitDoc.decantProductId,lot=splitDoc.perfumeLotId;
 const product=()=>db.collection('products').findOne({id:p});
 const stripTransferUnits=async id=>{const d=await doc(id);for(const line of d.lines){delete line.quantityUnit;for(const allocation of line.perfumeTransferAllocations??[])delete allocation.quantityUnit}await db.collection('documents').updateOne({id},{$set:{lines:d.lines}})};
 const transfer=async(quantity,{unmarked=true}={})=>{const id=await run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'w2',lines:[{productId:p,quantity}]});if(unmarked)await stripTransferUnits(id);return id};
 const migrate=()=>run({type:'perfume-volume.migrate',decantProductId:p,legacyPortionMl:10});
 // The public command correctly rejects new generic decant sales. Historical
 // persisted sales use the general accounting core plus their historical lot
 // allocation snapshot, then reverse through today's actual entrypoint.
 const oldSale=quantity=>db.transaction(async s=>{
  const sale=await historicalCommand(db,s,{type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:p,quantity,piecePrice:200}]});
  const current=await db.collection('products').findOne({id:p},{session:s}),batch=current.perfumeLots[0],d=await db.collection('documents').findOne({id:sale},{session:s});
  batch.remainingQuantity-=quantity;batch.stocks.w-=quantity;
  d.lines[0].perfumeAllocations=[{lotId:lot,quantity,unitCost:batch.liquidUnitCost,warehouseId:'w'}];
  await db.collection('products').updateOne({id:p},{$set:{perfumeLots:current.perfumeLots}},{session:s});
  await db.collection('documents').updateOne({id:sale},{$set:{lines:d.lines}},{session:s});return sale;
 });
 const report=async()=>(await buildReport(db,parseReportFilters(new URL('http://local/api/reports?type=overview&allTime=true')))).summary;
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts'].map(name=>db.collection(name).find().toArray()));
 const balance=async()=>{const productRow=await product();for(const wh of new Set([...Object.keys(productRow.stocks),...productRow.perfumeLots.flatMap(l=>Object.keys(l.stocks))]))assert.equal(productRow.stocks[wh]??0,productRow.perfumeLots.reduce((sum,l)=>sum+(l.stocks[wh]??0),0),wh);return productRow};
 return {db,run,doc,p,lot,split,product,transfer,migrate,oldSale,report,snapshot,balance,stripTransferUnits};
}

test('A02: legacy transfer survives ml migration and void restores quantity and value without rewriting its snapshot',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2),original=await f.doc(transfer),before=await f.report();
 await f.migrate();let p=await f.balance();assert.equal(p.stocks.w,80);assert.equal(p.stocks.w2,20);assert.equal(p.perfumeLots[0].liquidUnitCost,10);
 const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));await f.db.transaction(s=>restoreNativeBackup(f.db,backup,s));
 await f.run({type:'transfer.void',documentId:transfer});p=await f.balance();assert.equal(p.stocks.w,100);assert.equal(p.stocks.w2,0);
 assert.deepEqual((await f.doc(transfer)).lines,original.lines);assert.equal((await f.report()).currentInventoryValue,before.currentInventoryValue);
 const moves=await f.db.collection('stockMovements').find({documentId:transfer,type:'transfer-void'}).toArray();assert.deepEqual(moves.map(m=>m.quantityDelta).sort((a,b)=>a-b),[-20,20]);assert(moves.every(m=>m.quantityUnit==='ml'));
 const snapshot=await f.snapshot();await assert.rejects(f.run({type:'transfer.void',documentId:transfer}),/ملغى/);assert.deepEqual(await f.snapshot(),snapshot);
});

test('A02: editing a pre-migration transfer uses the old converted amount and the new ml draft exactly once',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2);await f.migrate();
 await f.run({type:'transfer.update',documentId:transfer,fromWarehouseId:'w',toWarehouseId:'w3',lines:[{productId:f.p,quantity:15}]});
 let p=await f.balance();assert.equal(p.stocks.w,85);assert.equal(p.stocks.w2,0);assert.equal(p.stocks.w3,15);assert.equal((await f.doc(transfer)).lines[0].quantity,15);
 await f.stripTransferUnits(transfer);
 await f.run({type:'transfer.void',documentId:transfer});p=await f.balance();assert.equal(p.stocks.w,100);assert.equal(p.stocks.w3,0);
});

test('A08: a legacy sale reversal cannot silently revalue restored portions after yield correction',async t=>{
 const f=await fixture(t),sale=await f.oldSale(2),correction=await f.run({type:'perfume-lot-correct.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w',actualQuantity:4,reason:'Counted yield'});
 const before=await f.snapshot(),report=await f.report();assert.equal((await f.product()).perfumeLots[0].liquidUnitCost,200);
 await assert.rejects(f.run({type:'sale.void',documentId:sale}),error=>{assert.equal(error.status,409);assert.match(error.message,/تكلفة|تقييم/);assert(error.dependencies.some(d=>d.documentId===correction));return true});
 assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await f.report(),report);
 await f.run({type:'perfume-management.void',documentId:correction});await f.run({type:'sale.void',documentId:sale});const p=await f.balance();assert.equal(p.stocks.w,10);assert.equal(p.perfumeLots[0].remainingQuantity,10);assert.equal(p.perfumeLots[0].liquidUnitCost,100);
});

test('A08: a normal legacy sale reverses after ml migration at its normalized historical valuation',async t=>{
 const f=await fixture(t),sale=await f.oldSale(2);await f.migrate();await f.run({type:'sale.void',documentId:sale});const p=await f.balance();assert.equal(p.stocks.w,100);assert.equal(p.perfumeLots[0].remainingQuantity,100);assert.equal(p.perfumeLots[0].liquidUnitCost,10);
});

test('A02: unmarked ml transfers posted after migration are not scaled for a second time',async t=>{
 const f=await fixture(t);await f.migrate();const transfer=await f.transfer(15);assert.equal((await f.product()).stocks.w2,15);await f.run({type:'transfer.void',documentId:transfer});const p=await f.balance();assert.equal(p.stocks.w,100);assert.equal(p.stocks.w2,0);
});

test('A02: a no-op legacy transfer revision retains its last stock-changing unit evidence',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2);await f.run({type:'transfer.update',documentId:transfer,fromWarehouseId:'w',toWarehouseId:'w2',lines:[{productId:f.p,quantity:2}]});await f.stripTransferUnits(transfer);await f.migrate();await f.run({type:'transfer.void',documentId:transfer});const p=await f.balance();assert.equal(p.stocks.w,100);assert.equal(p.stocks.w2,0);
});

test('A02: real valuation dependency guards remain enforced atomically',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2);await f.run({type:'perfume-lot-correct.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w',actualQuantity:6,reason:'Changed yield'});const before=await f.snapshot();await assert.rejects(f.run({type:'transfer.void',documentId:transfer}),/تكلفة الدفعة تغيرت/);assert.deepEqual(await f.snapshot(),before);
});

test('A02: converted allocation costs still reject a genuinely different ml valuation',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2),original=await f.doc(transfer);await f.migrate();const p=await f.product(),lots=structuredClone(p.perfumeLots);lots[0].liquidUnitCost=12;lots[0].landedUnitCost=12;
 assert.throws(()=>reversePerfumeLotTransfer(lots,'w','w2',original.lines[0].perfumeTransferAllocations),/تكلفة الدفعة تغيرت/);
});

test('A02: transferred liquid already consumed cannot be restored by drawing another warehouse negative',async t=>{
 const f=await fixture(t),transfer=await f.transfer(2);await f.migrate();await f.run({type:'perfume-lot-consume.post',decantProductId:f.p,lotId:f.lot,warehouseId:'w2',quantity:5,reason:'Samples',reasonCode:'samples'});const before=await f.snapshot();await assert.rejects(f.run({type:'transfer.void',documentId:transfer}),/تم التصرف فيه/);assert.deepEqual(await f.snapshot(),before);
});

for(const kind of ['consumption','yield-correction','opening'])test(`legacy ${kind} snapshot cannot be locked by a new ml migration`,async t=>{
 const f=await fixture(t);let operation,p=f.p;
 if(kind==='consumption')operation=await f.run({type:'perfume-lot-consume.post',decantProductId:p,lotId:f.lot,warehouseId:'w',quantity:1,reason:'Samples',reasonCode:'samples'});
 else if(kind==='yield-correction')operation=await f.run({type:'perfume-lot-correct.post',decantProductId:p,lotId:f.lot,warehouseId:'w',actualQuantity:9,reason:'Counted yield'});
 else{await f.db.collection('products').insertOne({id:'other-source',sku:'90',name:'Other perfume',perfumeForm:'full',stocks:{w:0},openingCost:1000,lastPurchaseCost:1000,pieceCost:1000,piecePrice:1500});operation=await f.run({type:'perfume-opening.post',sourceProductId:'other-source',warehouseId:'w',quantity:5,remainingValue:500,salePrice:200});p=(await f.doc(operation)).decantProductId}
 const before=await f.snapshot();let blocked;
 try{await f.run({type:'perfume-volume.migrate',decantProductId:p,legacyPortionMl:10})}catch(error){blocked=error}
 if(!blocked){let undoError;try{await f.run({type:'perfume-management.void',documentId:operation})}catch(error){undoError=error}assert.fail(`Migration accepted a legacy ${kind} snapshot; later reversal ${undoError?'failed: '+undoError.message:'succeeded unexpectedly'}`)}
 assert.equal(blocked.status,409);assert.equal(blocked.code,'PERFUME_OPERATION_BLOCKED');assert(blocked.dependencies.some(d=>d.documentId===operation));assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'perfume-management.void',documentId:operation});if(kind!=='opening'){await f.migrate();await f.balance()}
});
