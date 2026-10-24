import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';
import {transferPerfumeLotStock,reversePerfumeLotTransfer} from '../app/perfume-stock-reconciliation.ts';
import {buildReportFooterMetrics} from '../app/report-footer.ts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {managementInputFor} from '../app/perfume-management.ts';
const {createNativeBackupService}=createRequire(import.meta.url)('../desktop/native-backup.cjs');
const {createIsolatedBackupWriter}=createRequire(import.meta.url)('../desktop/backup-writer.cjs');

async function fixture(){
 const h=await sqliteHarness();await h.reset();const db=h.db,wh='wh-volume';
 await db.collection('warehouses').insertMany([{id:wh,name:'Test',isSalesDefault:true},{id:'wh-other',name:'Other',isSalesDefault:false}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([
  {id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{[wh]:3},openingCost:10000,lastPurchaseCost:10000,piecePrice:15000},
  {id:'b5',sku:'2',name:'5ml bottle',perfumeForm:'bottle',decantSizeMl:5,openingCost:20,lastPurchaseCost:20,stocks:{[wh]:20}},
  {id:'b10',sku:'3',name:'10ml bottle',perfumeForm:'bottle',decantSizeMl:10,openingCost:30,lastPurchaseCost:30,stocks:{[wh]:20}},
 ]);
 const run=body=>db.transaction(session=>execute(db,session,body));
 const split=await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:wh,volumeMl:100,priceBasisMl:10,salePrice:1500});
 const get=()=>db.collection('products').findOne({perfumeForm:'decant'});
 const product=await get(),p=product.id,lot=product.perfumeLots[0].id;
 const sale=lines=>run({type:'decant-sale.post',paymentMethod:'cash',lines:lines.map(line=>({productId:p,...line}))});
 const count=actualQuantity=>run({type:'perfume-lot-correct.post',decantProductId:p,lotId:lot,warehouseId:wh,actualQuantity,reason:'Actual count'});
 const report=()=>buildReport(db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=overview&allTime=true')));
 return {h,db,wh,run,split,get,p,lot,sale,count,report};
}

test('a saved native backup restores millilitres, defaults, revised bottle losses and report values, then remains reversible',async()=>{
 const f=await fixture();try{
  await f.run({type:'perfume-defaults.update',fillMl:5,bottleProductId:'b5'});
  await f.sale([{quantity:2,fillMl:5,bottleProductId:'b5',unitPrice:600}]);
  await f.count(93);
  const broken=await f.run({type:'perfume-bottle-stock.post',bottleProductId:'b5',warehouseId:f.wh,actualQuantity:17,bottleStockReason:'breakage',reason:'Broken bottle'});
  const first=await f.db.collection('documents').findOne({id:broken});
  const replacement=await f.run({type:'perfume-management.update',documentId:broken,expectedRevision:0,...managementInputFor(first,[]),actualQuantity:16});
  const before=(await f.report()).summary;
  assert.equal(before.inventoryGain,300);assert.equal(before.inventoryLoss,40);
  const snapshot=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db))), filePath=join(f.h.directory,'perfume-round-trip.conta.json');
  const owner={isDestroyed:()=>false};
  const service=createNativeBackupService({dialog:{showSaveDialog:async()=>({canceled:false,filePath})},getWindow:()=>owner,homeDirectory:f.h.directory,writeBackup:createIsolatedBackupWriter()});
  const saved=await service.save(async()=>new Response(JSON.stringify(snapshot),{headers:{'content-type':'application/json'}}));
  assert.equal(saved.ok,true);assert.equal(saved.canceled,false);
  const fromDisk=parseAndValidateBackup(await readFile(filePath,'utf8'));
  assert.equal(fromDisk.collections.appSettings.find(x=>x._id==='perfume-defaults').fillMl,5);
  await f.db.dropDatabase();
  await f.db.transaction(session=>restoreNativeBackup(f.db,fromDisk,session));
  const after=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
  for(const collection of ['products','documents','stockMovements','financialMovements','paymentAccounts','appSettings'])assert.deepEqual(after.collections[collection],snapshot.collections[collection],collection);
  const restored=(await f.report()).summary;
  for(const key of ['sales','salesProfit','inventoryLoss','inventoryGain','currentInventoryValue','netOperatingResult','currentAccountsBalance'])assert.equal(restored[key],before[key],key);
  assert.equal((await f.get()).stocks[f.wh],93);
  assert.equal((await f.db.collection('products').findOne({id:'b5'})).stocks[f.wh],16);
  await f.run({type:'perfume-management.void',documentId:replacement,expectedRevision:1});
  assert.equal((await f.db.collection('products').findOne({id:'b5'})).stocks[f.wh],18);
  assert.equal((await f.report()).summary.inventoryLoss,0);
  assert.equal((await f.report()).summary.inventoryGain,300);
 }finally{await f.h.close()}
});
test('volume split keeps the full source value and sells mixed sizes with separate bottles',async()=>{
 const f=await fixture();try{
  let p=await f.get();assert.equal(p.stocks[f.wh],100);assert.equal(p.perfumeLots[0].liquidUnitCost,100);assert.equal(p.perfumeLots[0].quantityUnit,'ml');
  assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks[f.wh],2);
  const sale=await f.sale([{quantity:2,fillMl:5,bottleProductId:'b5',unitPrice:600},{quantity:1,fillMl:10,bottleProductId:'b10',unitPrice:1100}]);
  const document=await f.db.collection('documents').findOne({id:sale});
  assert.equal(document.total,2300);assert.equal(document.lines.reduce((sum,l)=>sum+l.grossProfit,0),230);
  assert.deepEqual(document.lines.map(l=>l.liquidQuantityMl),[10,10]);
  assert.equal((await f.get()).stocks[f.wh],80);assert.equal((await f.db.collection('products').findOne({id:'b5'})).stocks[f.wh],18);
  await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks[f.wh],100);
  assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
 }finally{await f.h.close()}
});
test('fractional ml, capacity checks and aggregate shortages are atomic',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.sale([{quantity:1,fillMl:10,bottleProductId:'b5',unitPrice:1000}]),/سعة/);
  await assert.rejects(f.sale([{quantity:15,fillMl:5,bottleProductId:'b5',unitPrice:600},{quantity:3,fillMl:10,bottleProductId:'b10',unitPrice:1100}]),/غير كاف/);
  assert.equal((await f.get()).stocks[f.wh],100);assert.equal((await f.db.collection('products').findOne({id:'b5'})).stocks[f.wh],20);
  const sale=await f.sale([{quantity:3,fillMl:2.5,bottleProductId:'b5',unitPrice:400}]);assert.equal((await f.get()).stocks[f.wh],92.5);
  await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks[f.wh],100);
  await assert.rejects(f.sale([{quantity:1,fillMl:0.0001,bottleProductId:'b5',unitPrice:100}]),/الحجم/);
 }finally{await f.h.close()}
});
test('physical exhaustion records loss once and blocks old sale reversal until count is undone',async()=>{
 const f=await fixture();try{
  const sale=await f.sale([{quantity:9,fillMl:10,bottleProductId:'b10',unitPrice:1500}]);
  const count=await f.count(0),d=await f.db.collection('documents').findOne({id:count});
  assert.equal(d.inventoryLoss,1000);assert.equal(d.inventoryGain,0);assert.equal((await f.get()).stocks[f.wh],0);
  const r=await f.report();assert.equal(r.summary.inventoryLoss,1000);assert.equal(r.summary.netOperatingResult,3230);
  assert.equal((await f.db.collection('products').findOne({id:'b10'})).stocks[f.wh],11);
  await assert.rejects(f.run({type:'decant-sale.void',documentId:sale}),/تسوية/);
  await f.run({type:'perfume-management.void',documentId:count});assert.equal((await f.report()).summary.inventoryLoss,0);
  await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks[f.wh],100);
 }finally{await f.h.close()}
});
test('surplus at zero restores a costed quantity without cash, with guarded reversal',async()=>{
 const f=await fixture();try{
  const sale=await f.sale([{quantity:10,fillMl:10,bottleProductId:'b10',unitPrice:1500}]);
  const bank=(await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance;
  const count=await f.count(5),p=await f.get();assert.equal(p.stocks[f.wh],5);assert.equal(p.perfumeLots[0].liquidUnitCost,100);
  assert.equal((await f.report()).summary.inventoryGain,500);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,bank);
  const extra=await f.sale([{quantity:1,fillMl:5,bottleProductId:'b5',unitPrice:600}]);
  await assert.rejects(f.run({type:'perfume-management.void',documentId:count}),e=>e.dependencies.some(d=>d.documentId===extra));
  await f.run({type:'decant-sale.void',documentId:extra});await f.run({type:'perfume-management.void',documentId:count});
  assert.equal((await f.get()).stocks[f.wh],0);await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.get()).stocks[f.wh],100);
 }finally{await f.h.close()}
});
test('return uses the physical remainder once, preserves partial value and reverses atomically',async()=>{
 const f=await fixture();try{
  await f.db.collection('counters').updateOne({_id:'productSequence'},{$set:{value:0}});
  const returned=await f.run({type:'perfume-recombine.post',decantProductId:f.p,lotId:f.lot,warehouseId:f.wh,actualQuantity:90,reason:'Physical remainder',salePrice:12000});
  const document=await f.db.collection('documents').findOne({id:returned}),partial=await f.db.collection('products').findOne({id:document.partialProductId});
  assert.equal(partial.partialVolumeMl,90);assert.equal(partial.pieceCost,9000);assert.equal(document.inventoryLoss,1000);assert.equal((await f.get()).stocks[f.wh],0);
  assert.equal((await f.report()).summary.currentInventoryValue,20000+9000+1000);
  await assert.rejects(f.count(5),/أُرجع/);
  await f.run({type:'perfume-management.void',documentId:returned});assert.equal((await f.get()).stocks[f.wh],100);
  assert.equal((await f.db.collection('products').findOne({id:partial.id})).isArchived,true);
  assert.equal((await f.report()).summary.inventoryLoss,0);
 }finally{await f.h.close()}
});
test('empty return can settle a zero lot, and ml transfers retain lot and warehouse balances',async()=>{
 const f=await fixture();try{
  const initial=(await f.get()).perfumeLots;
  const transfer=transferPerfumeLotStock(initial,f.wh,'wh-other',2.5);
  assert.equal(transfer.lots[0].stocks[f.wh],97.5);assert.equal(transfer.lots[0].stocks['wh-other'],2.5);
  assert.deepEqual(reversePerfumeLotTransfer(transfer.lots,f.wh,'wh-other',transfer.allocations)[0].stocks,{[f.wh]:100,'wh-other':0});
  const sale=await f.sale([{quantity:10,fillMl:10,bottleProductId:'b10',unitPrice:1500}]);
  const closed=await f.run({type:'perfume-recombine.post',decantProductId:f.p,lotId:f.lot,warehouseId:f.wh,actualQuantity:0});
  const d=await f.db.collection('documents').findOne({id:closed});assert.equal(d.partialProductId,undefined);assert.equal(d.inventoryLoss,0);
  await f.run({type:'perfume-management.void',documentId:closed});await f.run({type:'decant-sale.void',documentId:sale});
 }finally{await f.h.close()}
});
test('legacy unit migration preserves value and old invoices, including their later reversal',async()=>{
 const f=await fixture();try{
  await f.db.collection('products').insertOne({id:'old',sku:'90',name:'Old decant',perfumeForm:'decant',pieceCost:2500,piecePrice:3000,stocks:{[f.wh]:4},perfumeLots:[{id:'old-lot',sourceProductId:'full',sourceProductName:'Old',originalQuantity:4,remainingQuantity:4,liquidUnitCost:2500,landedUnitCost:2500,stocks:{[f.wh]:4},createdAt:'2026-01-01',conversionDocumentId:'old-split'}]});
  const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:'old',quantity:1,unitPrice:3000,bottleProductId:'b10'}]});
  const before=await f.db.collection('documents').findOne({id:sale});
  const migration=await f.run({type:'perfume-volume.migrate',decantProductId:'old',legacyPortionMl:10});
  await assert.rejects(f.run({type:'adjustment.void',documentId:migration}),/تهيئة وحدة قياس/);
  const p=await f.db.collection('products').findOne({id:'old'});assert.equal(p.stocks[f.wh],30);assert.equal(p.perfumeLots[0].liquidUnitCost,250);
  assert.deepEqual(await f.db.collection('documents').findOne({id:sale}),before);
  await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.db.collection('products').findOne({id:'old'})).stocks[f.wh],40);
  await assert.rejects(f.run({type:'perfume-volume.migrate',decantProductId:'old',legacyPortionMl:10}),/بالفعل/);
  const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
  await f.db.transaction(session=>restoreNativeBackup(f.db,backup,session));
  assert.equal((await f.db.collection('products').findOne({id:'old'})).perfumeStockUnit,'ml');
 }finally{await f.h.close()}
});
test('default fill is configurable and cannot exceed the selected bottle',async()=>{
 const f=await fixture();try{
  await f.run({type:'perfume-defaults.update',fillMl:5,bottleProductId:'b5'});
  await assert.rejects(f.run({type:'perfume-defaults.update',fillMl:10,bottleProductId:'b5'}),/تتسع/);
  assert.equal((await f.db.collection('appSettings').findOne({_id:'perfume-defaults'})).fillMl,5);
 }finally{await f.h.close()}
});
test('opened volume, independent sample bottles and fractional warehouse transfers preserve balances',async()=>{
 const f=await fixture();try{
  const opening=await f.run({type:'perfume-opening.post',sourceProductId:'full',warehouseId:f.wh,volumeMl:1.25,remainingValue:125,salePrice:1500});
  const p=await f.get(),opened=p.perfumeLots.find(l=>l.conversionDocumentId===opening);
  assert.equal(p.stocks[f.wh],101.25);assert.equal(opened.liquidUnitCost,100);
  const consume=await f.run({type:'perfume-lot-consume.post',decantProductId:f.p,lotId:opened.id,warehouseId:f.wh,quantity:1.25,reason:'Samples',reasonCode:'samples',consumeBottle:true,bottleQuantity:2,bottleProductId:'b10'});
  assert.equal((await f.get()).stocks[f.wh],100);assert.equal((await f.db.collection('products').findOne({id:'b10'})).stocks[f.wh],18);
  assert.equal((await f.db.collection('documents').findOne({id:consume})).inventoryLoss,185);
  await f.run({type:'perfume-management.void',documentId:consume});assert.equal((await f.get()).stocks[f.wh],101.25);
  await assert.rejects(f.run({type:'adjustment.post',warehouseId:f.wh,reason:'Wrong screen',lines:[{productId:f.p,actualQuantity:90}]}),/دفعات التقسيمات/);
  const transfer=await f.run({type:'transfer.post',fromWarehouseId:f.wh,toWarehouseId:'wh-other',lines:[{productId:f.p,quantity:2.5}]});
  assert.equal((await f.get()).stocks['wh-other'],2.5);
  await assert.rejects(f.run({type:'perfume-recombine.post',decantProductId:f.p,lotId:f.lot,warehouseId:f.wh,actualQuantity:97.5,salePrice:10000}),/مخزن واحد/);
  await f.run({type:'transfer.void',documentId:transfer});assert.equal((await f.get()).stocks[f.wh],101.25);assert.equal((await f.get()).stocks['wh-other'],0);
  const stock=await buildReport(f.db,parseReportFilters(new URL(`http://127.0.0.1/api/reports?type=stock&allTime=true&productId=${f.p}`)));
  assert.equal(stock.summary.hasVolumeUnits,true);assert.equal(stock.summary.hasPieceUnits,false);
 }finally{await f.h.close()}
});
test('deleting an empty warehouse with retained stock keys and import mappings archives it and keeps backups valid',async()=>{
 const f=await fixture();try{
  await f.db.collection('products').updateOne({id:'full'},{$set:{'stocks.wh-other':0}});
  await f.db.collection('importMappings').insertOne({id:'warehouse-map',sourceType:'dataacc-sqlite',sourceEntityType:'warehouses',sourceKey:'legacy-other',targetEntityType:'warehouses',targetId:'wh-other'});
  await f.run({type:'warehouse.delete',id:'wh-other'});
  assert.equal((await f.db.collection('warehouses').findOne({id:'wh-other'})).isArchived,true);
  assert.equal((await f.db.collection('products').findOne({id:'full'})).stocks['wh-other'],0);
  const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
  await f.db.transaction(session=>restoreNativeBackup(f.db,backup,session));
  assert.equal((await f.db.collection('warehouses').findOne({id:'wh-other'})).isArchived,true);
 }finally{await f.h.close()}
});
test('voiding the last bottle purchase restores opening cost for the next decant sale',async()=>{
 const f=await fixture();try{
  const purchase=await f.run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:'b5',quantity:5,unitPrice:25}]});
  await f.run({type:'decant-purchase.void',documentId:purchase});
  assert.equal((await f.db.collection('products').findOne({id:'b5'})).lastPurchaseCost,20);
  const sale=await f.sale([{quantity:1,fillMl:5,bottleProductId:'b5',unitPrice:600}]);
  const d=await f.db.collection('documents').findOne({id:sale});
  assert.equal(d.lines[0].bottleUnitCost,20);assert.equal(d.lines[0].costAtSale,520);
  assert.equal((await f.report()).summary.salesProfit,80);
 }finally{await f.h.close()}
});
test('a missing bottle cost cache resolves the opening cost instead of treating null as zero',async()=>{
 const f=await fixture();try{
  await f.db.collection('products').updateOne({id:'b5'},{$set:{lastPurchaseCost:null}});
  const sale=await f.sale([{quantity:1,fillMl:5,bottleProductId:'b5',unitPrice:600}]);
  assert.equal((await f.db.collection('documents').findOne({id:sale})).lines[0].bottleUnitCost,20);
 }finally{await f.h.close()}
});
test('overview profit details reconcile with the decant sales total',async()=>{
 const f=await fixture();try{
  await f.sale([{quantity:2,fillMl:5,bottleProductId:'b5',unitPrice:600},{quantity:1,fillMl:10,bottleProductId:'b10',unitPrice:1100}]);
  const r=await f.report();assert.equal(r.overviewDetails.salesProfit.length,1);
  assert.equal(r.overviewDetails.salesProfit.reduce((sum,row)=>sum+row.profit,0),230);
  assert.equal(r.summary.salesProfit,230);
 }finally{await f.h.close()}
});
test('product activity separates ml balance and sold bottle counts, including export footer totals',async()=>{
 const f=await fixture();try{
  await f.sale([{quantity:2,fillMl:5,bottleProductId:'b5',unitPrice:600},{quantity:1,fillMl:10,bottleProductId:'b10',unitPrice:1100}]);
  const r=await buildReport(f.db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=product-sales&allTime=true')));
  const row=r.rows.find(row=>row.productId===f.p);
  assert.equal(row.soldQuantity,3);assert.equal(row.soldVolumeMl,20);assert.equal(row.currentQuantity,80);assert.equal(row.quantityUnit,'ml');
  assert.equal(r.summary.remainingMl,80);assert.equal(r.summary.remainingPieces,2+18+19);
  const metrics=buildReportFooterMetrics({type:'product-sales',result:r});
  assert.equal(metrics.find(m=>m.key==='remainingMl').value,80);
  assert.equal(metrics.find(m=>m.key==='remainingPieces').value,39);
  assert.equal(metrics.some(m=>m.key==='quantity'),false);
 }finally{await f.h.close()}
});
test('new split reversals on migrated ml products retain their explicit unit in stock reports',async()=>{
 const f=await fixture();try{
  await f.db.collection('products').updateOne({id:f.p},{$set:{legacyDecantUnitMl:10}});
  const cleared=await f.count(0);
  const split=await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:f.wh,volumeMl:0.333,priceBasisMl:10,salePrice:1500});
  await f.run({type:'perfume-management.void',documentId:split});
  await f.run({type:'perfume-management.void',documentId:cleared});
  const r=await buildReport(f.db,parseReportFilters(new URL(`http://127.0.0.1/api/reports?type=stock&allTime=true&productId=${f.p}`)));
  assert.equal(r.rows.find(row=>row.documentId===split&&row.change<0).change,-0.333);
  assert.equal(r.summary.incomingMl-r.summary.outgoingMl,100);
  assert.equal((await f.get()).stocks[f.wh],100);
 }finally{await f.h.close()}
});
