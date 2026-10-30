import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {conversionSourceProducts,managementInputFor,managementTabForKind} from '../app/perfume-management.ts';
import {defaultWarehouse,soleWarehouseId,warehouseSelectionId} from '../app/warehouse-selection.ts';
import {openingLiquidValue} from '../app/perfume-opening-valuation.ts';
import {createNativeBackup,parseAndValidateBackup} from '../lib/backup.ts';

async function fixture(t){
 const h=await sqliteHarness();await h.reset();t.after(()=>h.close());const db=h.db;
 await db.collection('warehouses').insertMany([{id:'w',name:'Only',isSalesDefault:false},{id:'archived',name:'Old',isSalesDefault:true,isArchived:true}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',openingBalance:10000,balance:10000,isActive:true});
 await db.collection('products').insertMany([
  {id:'full',sku:'1',name:'Full',perfumeForm:'full',stocks:{w:2},openingCost:1000,lastPurchaseCost:9999,pieceCost:9999,piecePrice:1500},
  {id:'other',sku:'2',name:'Other',perfumeForm:'full',stocks:{},openingCost:500,pieceCost:500,piecePrice:900},
  {id:'glass',sku:'3',name:'10 ml',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:20},openingCost:5,lastPurchaseCost:5,pieceCost:5},
 ]);
 const run=b=>db.transaction(s=>execute(db,s,b));
 const doc=id=>db.collection('documents').findOne({id}),product=id=>db.collection('products').findOne({id});
 const opening=overrides=>run({type:'perfume-opening.post',sourceProductId:'full',warehouseId:'w',volumeMl:40,originalVolumeMl:100,remainingValue:999999,salePrice:150,...overrides});
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts'].map(n=>db.collection(n).find().toArray()));
 const report=async()=>(await buildReport(db,parseReportFilters(new URL('http://localhost/api/reports?type=overview&allTime=true')))).summary;
 return {db,run,doc,product,opening,snapshot,report};
}

test('sole active warehouse prepares fresh and stale drafts, while document snapshots and multiple choices remain explicit',()=>{
 const only={id:'w',isSalesDefault:false},old={id:'old',isSalesDefault:true,isArchived:true};
 assert.equal(defaultWarehouse([old,only]),only);assert.equal(soleWarehouseId([old,only]),'w');
 assert.equal(warehouseSelectionId([old,only],''),'w');assert.equal(warehouseSelectionId([old,only],'deleted'),'w');
 assert.equal(warehouseSelectionId([old,only],'old',true),'old');assert.equal(warehouseSelectionId([old,only],'',true),'');
 assert.equal(defaultWarehouse([only,{id:'w2'}]),undefined);assert.equal(soleWarehouseId([old]),'');
 assert.equal(warehouseSelectionId([only,{id:'w2'}],''),'');
 assert.equal(defaultWarehouse([only,{id:'w2',isSalesDefault:true}]).id,'w2');
 assert.equal(managementTabForKind('recombine'),'convert');assert.equal(managementTabForKind('consumption'),'stock');assert.equal(managementTabForKind('bottle-stock'),'bottles');
});
test('conversion source search hides unavailable full bottles in the selected warehouse, but retains an edited source',()=>{
 const products=[{id:'yes',stocks:{w:1}},{id:'zero',stocks:{w:0}},{id:'elsewhere',stocks:{w2:3}},{id:'fraction',stocks:{w:.5}},{id:'old',isArchived:true,stocks:{w:1}},{id:'glass',perfumeForm:'bottle',stocks:{w:4}},{id:'partial',perfumeForm:'partial',stocks:{w:1}},{id:'decant',perfumeForm:'decant',stocks:{w:100}}];
 assert.deepEqual(conversionSourceProducts(products,'w').map(p=>p.id),['yes']);
 assert.deepEqual(conversionSourceProducts(products,'w2').map(p=>p.id),['elsewhere']);
 assert.deepEqual(conversionSourceProducts(products,'w','zero').map(p=>p.id),['yes','zero']);
 assert.deepEqual(conversionSourceProducts(products,'').map(p=>p.id),[]);
});
test('remaining liquid uses a default 100 ml original and supports precise custom sizes',()=>{
 assert.equal(openingLiquidValue(1000,40).remainingValue,400);
 assert.equal(openingLiquidValue(1000,40,200).remainingValue,200);
 assert.equal(openingLiquidValue(950,12.5,50).remainingValue,237.5);
 assert.throws(()=>openingLiquidValue(1000,101,100),/يتجاوز/);
 assert.throws(()=>openingLiquidValue(0,40,100),/تكلفة شراء/);
});
test('new automatic opening uses authoritative cost, ignores a forged remaining value, and posts no cash or loss',async t=>{
 const f=await fixture(t),before=await f.report(),id=await f.opening(),d=await f.doc(id),p=await f.product(d.decantProductId);
 assert.equal(d.bookValueAfter,400);assert.equal(d.openingBottleCost,1000);assert.equal(d.openingOriginalVolumeMl,100);
 assert.equal(d.managementInput.remainingValue,400);assert.equal(p.stocks.w,40);assert.equal(p.perfumeLots[0].liquidUnitCost,10);
 const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db))),saved=backup.collections.documents.find(row=>row.id===id);
 assert.equal(saved.openingBottleCost,1000);assert.equal(saved.openingOriginalVolumeMl,100);assert.equal(saved.managementInput.originalVolumeMl,100);
 assert.equal((await f.product('full')).stocks.w,2);assert.equal(await f.db.collection('financialMovements').countDocuments(),0);
 const after=await f.report();assert.equal(after.currentInventoryValue-before.currentInventoryValue,400);
 for(const key of ['inventoryLoss','inventoryGain','sales','purchases','netOperatingResult','currentAccountsBalance'])assert.equal(after[key],before[key],key);
 await f.run({type:'perfume-management.void',documentId:id});assert.equal((await f.product(d.decantProductId)).stocks.w,0);assert.equal((await f.report()).currentInventoryValue,before.currentInventoryValue);
});
test('editing automatic remaining stock retains the historic full-bottle cost, adjusts the original size, and can be canceled',async t=>{
 const f=await fixture(t),id=await f.opening(),original=await f.doc(id);
 await f.db.collection('products').updateOne({id:'full'},{$set:{openingCost:2000,lastPurchaseCost:2000}});
 const editedId=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(original,[]),originalVolumeMl:200,volumeMl:30,remainingValue:1});
 const d=await f.doc(editedId);assert.equal(d.openingBottleCost,1000);assert.equal(d.bookValueAfter,150);assert.equal((await f.doc(id)).status,'voided');
 const p=await f.product(d.decantProductId);assert.equal(p.stocks.w,30);assert.equal(p.perfumeLots[0].liquidUnitCost,5);
 await f.run({type:'perfume-management.void',documentId:editedId,expectedRevision:1});assert.equal((await f.product(d.decantProductId)).stocks.w,0);assert.equal((await f.product('full')).stocks.w,2);
});
test('switching the opening source derives the new source cost instead of reusing the old snapshot',async t=>{
 const f=await fixture(t),id=await f.opening(),d=await f.doc(id);
 const changed=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(d,[]),sourceProductId:'other',volumeMl:40});
 const replacement=await f.doc(changed);assert.equal(replacement.openingBottleCost,500);assert.equal(replacement.bookValueAfter,200);
});
test('invalid original volume, excessive remaining liquid and missing source cost roll back atomically',async t=>{
 const f=await fixture(t);
 for(const patch of [{originalVolumeMl:0},{volumeMl:101},{originalVolumeMl:'abc'}]){const before=await f.snapshot();await assert.rejects(f.opening(patch));assert.deepEqual(await f.snapshot(),before)}
 await f.db.collection('products').updateOne({id:'full'},{$unset:{openingCost:1,lastPurchaseCost:1}});
 const before=await f.snapshot();await assert.rejects(f.opening(),/تكلفة شراء/);assert.deepEqual(await f.snapshot(),before);
});
test('legacy manual millilitre openings retain their recorded value on edit',async t=>{
 const f=await fixture(t),id=await f.opening({originalVolumeMl:undefined,remainingValue:333}),d=await f.doc(id);
 const revised=await f.run({type:'perfume-management.update',documentId:id,...managementInputFor(d,[]),note:'Only note'});
 assert.equal((await f.doc(revised)).bookValueAfter,333);assert.equal((await f.doc(revised)).openingBottleCost,undefined);
});
test('specialized sale and bottle purchase both use the sole active warehouse without requiring the default flag',async t=>{
 const f=await fixture(t),id=await f.opening(),d=await f.doc(id);
 await f.db.collection('products').updateOne({id:'glass'},{$set:{decantSizeMl:5}});
 const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:d.decantProductId,quantity:1,fillMl:5,bottleProductId:'glass',unitPrice:100}]});
 assert.equal((await f.doc(sale)).warehouseId,'w');assert.equal((await f.product(d.decantProductId)).stocks.w,35);
 const purchase=await f.run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:'glass',quantity:2,unitPrice:5}]});assert.equal((await f.doc(purchase)).warehouseId,'w');
 await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.product(d.decantProductId)).stocks.w,40);
 await f.run({type:'decant-purchase.void',documentId:purchase});assert.equal((await f.product('glass')).stocks.w,20);
});
