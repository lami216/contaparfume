import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';

async function fixture(t,{legacy=false}={}){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertOne({_id:'w',name:'Test',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([
  {id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{w:1},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500},
  ...[2,5,10].map((capacity,i)=>({id:`b${capacity}`,sku:String(i+2),name:`Bottle ${capacity}`,perfumeForm:'bottle',decantSizeMl:capacity,stocks:{w:100},openingCost:20,lastPurchaseCost:20,pieceCost:20})),
 ]);
 const run=body=>db.transaction(s=>execute(db,s,body));
 const split=await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',salePrice:200,priceBasisMl:10,...(legacy?{divisionsCount:10}:{volumeMl:100})});
 const source=await db.collection('documents').findOne({id:split}),p=source.decantProductId;
 const product=id=>db.collection('products').findOne({id}),doc=id=>db.collection('documents').findOne({id});
 const post=(line={},extra={})=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:p,bottleProductId:'b10',quantity:2,unitPrice:200,...line}],...extra});
 const edit=async(id,line={},extra={})=>{const saved=await doc(id);return run({type:'decant-sale.update',documentId:id,expectedRevision:saved.revision??0,paymentMethod:saved.paymentMethod,partyId:saved.partyId,lines:saved.lines.map(l=>({productId:l.productId,bottleProductId:l.bottleProductId,quantity:l.quantity,unitPrice:l.unitPrice,...line})),...extra})};
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts','parties','counters','productCategories'].map(n=>db.collection(n).find().toArray()));
 const report=async()=>(await buildReport(db,parseReportFilters(new URL('http://local/api/reports?type=overview&allTime=true')))).summary;
 return{db,run,p,product,doc,post,edit,snapshot,report};
}

for(const capacity of [2,5,10])test(`registered ${capacity}ml bottle determines liquid, costs, report and reversal without fill input`,async t=>{
 const f=await fixture(t),before=await f.report(),id=await f.post({bottleProductId:`b${capacity}`,quantity:3,unitPrice:capacity*20});
 const saved=await f.doc(id),line=saved.lines[0],cost=3*(capacity*10+20);
 assert.equal(line.fillMl,capacity);assert.equal(line.liquidQuantityMl,capacity*3);assert.equal(line.bottleQuantity,3);
 assert.equal(line.costAtSale*3,cost);assert.equal(line.grossProfit,saved.total-cost);
 assert.equal((await f.product(f.p)).stocks.w,100-capacity*3);assert.equal((await f.product(`b${capacity}`)).stocks.w,97);
 assert.equal((await f.report()).salesCost,cost);assert.equal((await f.report()).salesProfit,saved.total-cost);
 const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));await f.db.transaction(s=>restoreNativeBackup(f.db,backup,s));
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product(`b${capacity}`)).stocks.w,100);
 assert.deepEqual(await f.report(),before);
});

test('spoofed fill is rejected atomically and client capacity/liquid snapshots cannot replace registered capacity',async t=>{
 const f=await fixture(t);
 for(const fillMl of [1,10,0,-1,0.0001,'bad']){const before=await f.snapshot();await assert.rejects(f.post({bottleProductId:'b5',fillMl}));assert.deepEqual(await f.snapshot(),before);}
 const id=await f.post({bottleProductId:'b5',fillMl:5,decantSizeMl:1,liquidQuantityMl:1,bottleUnitCost:0,costAtSale:0});
 const line=(await f.doc(id)).lines[0];assert.equal(line.fillMl,5);assert.equal(line.liquidQuantityMl,10);assert.equal(line.costAtSale,70);assert.equal((await f.product(f.p)).stocks.w,90);
});

test('new bottled lines require a valid active registered capacity and cannot change data on failure',async t=>{
 const f=await fixture(t);
 for(const capacity of [null,0,-1,'',true,0.0001,'bad']){
  await f.db.collection('products').updateOne({id:'b5'},{$set:{decantSizeMl:capacity}});const before=await f.snapshot();
  await assert.rejects(f.post({bottleProductId:'b5'}),/سعة/);assert.deepEqual(await f.snapshot(),before);
 }
 await f.db.collection('products').updateOne({id:'b5'},{$unset:{decantSizeMl:1}});let before=await f.snapshot();await assert.rejects(f.post({bottleProductId:'b5'}),/سعة/);assert.deepEqual(await f.snapshot(),before);
 await f.db.collection('products').updateOne({id:'b5'},{$set:{decantSizeMl:5,isArchived:true}});before=await f.snapshot();await assert.rejects(f.post({bottleProductId:'b5'}));assert.deepEqual(await f.snapshot(),before);
});

test('header and price edits keep saved liquid and bottle costs after registered capacity and purchase cost change',async t=>{
 const f=await fixture(t),id=await f.post(),original=await f.doc(id),before=await f.report();
 await f.db.collection('products').updateOne({id:'b10'},{$set:{decantSizeMl:2,lastPurchaseCost:50,pieceCost:50}});
 const partyId=await f.run({type:'party.create',partyType:'customer',name:'Customer'});
 await f.edit(id,{}, {partyId});let line=(await f.doc(id)).lines[0];
 assert.equal(line.fillMl,10);assert.equal(line.liquidQuantityMl,20);assert.equal(line.costAtSale,120);assert.equal(line.bottleUnitCost,20);assert.deepEqual(line.perfumeAllocations,original.lines[0].perfumeAllocations);
 assert.equal((await f.product(f.p)).stocks.w,80);assert.equal((await f.report()).salesCost,before.salesCost);
 await f.db.collection('products').updateOne({id:'b10'},{$unset:{decantSizeMl:1}});await f.edit(id);assert.equal((await f.doc(id)).lines[0].liquidQuantityMl,20);
 await f.edit(id,{fillMl:10,unitPrice:250});line=(await f.doc(id)).lines[0];assert.equal(line.costAtSale,120);assert.equal(line.grossProfit,260);
 const snapshot=await f.snapshot();await assert.rejects(f.edit(id,{fillMl:2}),/التعبئة/);assert.deepEqual(await f.snapshot(),snapshot);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('b10')).stocks.w,100);
});

test('changing count or bottle uses its current capacity and authoritative current cost',async t=>{
 const f=await fixture(t),id=await f.post();await f.db.collection('products').updateOne({id:'b10'},{$set:{decantSizeMl:2,lastPurchaseCost:50,pieceCost:50}});
 await f.edit(id,{quantity:3});let line=(await f.doc(id)).lines[0];assert.equal(line.fillMl,2);assert.equal(line.liquidQuantityMl,6);assert.equal(line.costAtSale,70);assert.equal((await f.product(f.p)).stocks.w,94);assert.equal((await f.product('b10')).stocks.w,97);
 await f.edit(id,{bottleProductId:'b5'});line=(await f.doc(id)).lines[0];assert.equal(line.fillMl,5);assert.equal(line.liquidQuantityMl,15);assert.equal(line.costAtSale,70);assert.equal((await f.product(f.p)).stocks.w,85);assert.equal((await f.product('b10')).stocks.w,100);assert.equal((await f.product('b5')).stocks.w,97);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('b5')).stocks.w,100);
});

test('unchanged historical partial-fill invoices retain their exact stored ml and costs',async t=>{
 const f=await fixture(t),id=await f.post(),saved=await f.doc(id),p=await f.product(f.p);
 // Explicit old-format fixture: older releases permitted 5ml in a 10ml bottle.
 // Persist its complete quantities/cost evidence, then use current commands.
 saved.lines[0]={...saved.lines[0],fillMl:5,liquidQuantityMl:10,costAtSale:70,grossProfit:260,perfumeAllocations:saved.lines[0].perfumeAllocations.map(a=>({...a,quantity:10}))};
 p.perfumeLots[0].remainingQuantity=90;p.perfumeLots[0].stocks.w=90;
 await f.db.collection('products').updateOne({id:f.p},{$set:{'stocks.w':90,perfumeLots:p.perfumeLots}});
 await f.db.collection('documents').updateOne({id},{$set:{lines:saved.lines}});
 await f.db.collection('stockMovements').updateOne({documentId:id,type:'decant-sale-liquid'},{$set:{quantityDelta:-10,balanceAfter:90}});
 await f.db.collection('products').updateOne({id:'b10'},{$set:{decantSizeMl:2,lastPurchaseCost:50}});
 await f.edit(id,{fillMl:5});const line=(await f.doc(id)).lines[0];assert.equal(line.fillMl,5);assert.equal(line.liquidQuantityMl,10);assert.equal(line.costAtSale,70);assert.equal((await f.product(f.p)).stocks.w,90);
 delete line.fillMl;await f.db.collection('documents').updateOne({id},{$set:{lines:[line]}});await f.edit(id);assert.equal((await f.doc(id)).lines[0].fillMl,5);assert.equal((await f.doc(id)).lines[0].liquidQuantityMl,10);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('b10')).stocks.w,100);
});

test('legacy piece-unit sales remain piece based and migrated header edits normalize their saved allocation once',async t=>{
 const f=await fixture(t,{legacy:true});await f.db.collection('products').updateOne({id:'b10'},{$unset:{decantSizeMl:1}});const id=await f.post({quantity:2}),original=await f.doc(id);
 assert.equal(original.lines[0].fillMl,undefined);assert.equal(original.lines[0].liquidQuantityMl,undefined);assert.equal((await f.product(f.p)).stocks.w,8);
 await f.run({type:'perfume-volume.migrate',decantProductId:f.p,legacyPortionMl:10});await f.db.collection('products').updateOne({id:'b10'},{$set:{decantSizeMl:2,lastPurchaseCost:50}});
 await f.edit(id);const line=(await f.doc(id)).lines[0];assert.equal(line.fillMl,10);assert.equal(line.liquidQuantityMl,20);assert.equal(line.costAtSale,original.lines[0].costAtSale);assert.equal(line.bottleUnitCost,20);assert.equal(line.perfumeAllocations[0].quantityUnit,'ml');assert.equal(line.perfumeAllocations[0].quantity,20);assert.equal((await f.product(f.p)).stocks.w,80);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('b10')).stocks.w,100);
});
