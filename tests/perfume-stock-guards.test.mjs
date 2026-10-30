import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';
import {managementInputFor,managementPreviewLot} from '../app/perfume-management.ts';
import {GET as history} from '../app/api/history/route.ts';

async function fixture(){
 const h=await sqliteHarness();await h.reset();const db=h.db,wh='wh-guard';
 await db.collection('warehouses').insertMany([{id:wh,name:'One',isSalesDefault:true},{id:'other',name:'Two'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([{id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{[wh]:5,other:1},openingCost:10000,lastPurchaseCost:10000,piecePrice:15000},{id:'b',sku:'2',name:'Bottle',perfumeForm:'bottle',decantSizeMl:10,openingCost:20,lastPurchaseCost:20,stocks:{[wh]:50}}]);
 const run=body=>db.transaction(session=>execute(db,session,body));
 const split=()=>run({type:'perfume-split.post',sourceProductId:'full',warehouseId:wh,volumeMl:100,priceBasisMl:10,salePrice:1500});
 const source=await split(),get=()=>db.collection('products').findOne({perfumeForm:'decant',isArchived:{$ne:true}}),p=await get(),lot=p.perfumeLots[0].id;
 const consume=(amount=10)=>run({type:'perfume-lot-consume.post',decantProductId:p.id,lotId:lot,warehouseId:wh,quantity:amount,reason:'Sample',reasonCode:'samples'});
 const sale=(quantity=9)=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:p.id,quantity,fillMl:10,bottleProductId:'b',unitPrice:1500}]});
 const count=actualQuantity=>run({type:'perfume-lot-correct.post',decantProductId:p.id,lotId:lot,warehouseId:wh,actualQuantity,reason:'Measured'});
 const report=(suffix='')=>buildReport(db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=overview&allTime=true'+suffix)));
 const cancel=id=>run({type:'perfume-management.void',documentId:id});
 return {h,db,wh,run,split,source,get,p:p.id,lot,consume,sale,count,report,cancel};
}

test('consumption cancellation preserves quantities restored by voiding an earlier sale',async()=>{const f=await fixture();try{
 const sale=await f.sale(),consumption=await f.consume();await f.run({type:'decant-sale.void',documentId:sale});
 assert.equal((await f.db.collection('documents').findOne({id:consumption})).quantityUnit,'ml');
 assert.equal((await f.get()).stocks[f.wh],90);assert.equal((await f.report()).summary.inventoryLoss,1000);
 await f.cancel(consumption);assert.equal((await f.get()).stocks[f.wh],100);
 const s=(await f.report()).summary;assert.equal(s.inventoryLoss,0);assert.equal(s.sales,0);assert.equal(s.currentAccountsBalance,10000);
 await assert.rejects(f.cancel(consumption),/ملغاة/);
}finally{await f.h.close()}});

test('editing consumption after an earlier sale reversal uses the current inverse balance',async()=>{const f=await fixture();try{
 const sale=await f.sale(),id=await f.consume();await f.run({type:'decant-sale.void',documentId:sale});
 const d=await f.db.collection('documents').findOne({id}),p=await f.get();
 assert.equal(managementPreviewLot(d,p.id,f.lot,f.wh,p.perfumeLots[0]).stocks[f.wh],100);
 const replacement=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(d,[]),quantity:5});
 assert.equal((await f.get()).stocks[f.wh],95);assert.equal((await f.report()).summary.inventoryLoss,500);
 await f.cancel(replacement);assert.equal((await f.get()).stocks[f.wh],100);assert.equal((await f.report()).summary.inventoryLoss,0);
}finally{await f.h.close()}});

test('a reconciliation reversal also preserves the reversal of an earlier sale',async()=>{const f=await fixture();try{
 const sale=await f.sale(),count=await f.count(5);await f.run({type:'decant-sale.void',documentId:sale});
 await f.cancel(count);const p=await f.get();assert.equal(p.stocks[f.wh],100);assert.equal(p.perfumeLots[0].remainingQuantity,100);assert.equal((await f.report()).summary.inventoryLoss,0);
}finally{await f.h.close()}});

test('active later sales and counts identify their real document and do not mutate stock',async()=>{const f=await fixture();try{
 const consumption=await f.consume(),sale=await f.sale(1),d=await f.db.collection('documents').findOne({id:sale});
 await assert.rejects(f.cancel(consumption),e=>e.code==='PERFUME_OPERATION_BLOCKED'&&e.dependencies.some(x=>x.documentId===sale&&x.number===d.number));
 assert.equal((await f.get()).stocks[f.wh],80);
 await f.run({type:'decant-sale.void',documentId:sale});const count=await f.count(85);
 await assert.rejects(f.cancel(consumption),e=>e.dependencies.some(x=>x.documentId===count));
 await f.cancel(count);await f.cancel(consumption);assert.equal((await f.get()).stocks[f.wh],100);
}finally{await f.h.close()}});

test('a new conversion requires clearing all previous liquid across warehouses, atomically',async()=>{const f=await fixture();try{
 const before=await createNativeBackup(f.db);
 for(const warehouseId of [f.wh,'other'])await assert.rejects(f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId,volumeMl:100,salePrice:1500}),e=>e.code==='PERFUME_OPERATION_BLOCKED'&&e.dependencies.some(x=>x.documentId===f.source));
 const after=await createNativeBackup(f.db);for(const k of ['products','documents','stockMovements','financialMovements','paymentAccounts'])assert.deepEqual(after.collections[k],before.collections[k]);
 const count=await f.count(0);assert.equal((await f.report()).summary.inventoryLoss,10000);const next=await f.split();
 await assert.rejects(f.cancel(count),e=>e.dependencies.some(x=>x.documentId===next));
 await f.cancel(next);await f.cancel(count);assert.equal((await f.get()).stocks[f.wh],100);assert.equal((await f.report()).summary.inventoryLoss,0);
}finally{await f.h.close()}});

test('a sold-out lot can be replaced, but reversing its consumption cannot open two lots',async()=>{const f=await fixture();try{
 const old=await f.consume(100),next=await f.split();await assert.rejects(f.cancel(old),e=>e.dependencies.some(x=>x.documentId===next));
 await f.cancel(next);await f.cancel(old);assert.equal((await f.get()).stocks[f.wh],100);
}finally{await f.h.close()}});

test('unexplained changed valuation is a data error with no invented linked operation',async()=>{const f=await fixture();try{
 const id=await f.consume();const p=await f.get();p.perfumeLots[0].liquidUnitCost=101;
 await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeLots:p.perfumeLots}});
 await assert.rejects(f.cancel(id),e=>e.dependencies.length===0&&e.message.includes('تكلفتها تغيرت'));
 assert.equal((await f.get()).stocks[f.wh],90);
}finally{await f.h.close()}});

test('loss and gain details equal their report totals and keep original source types',async()=>{const f=await fixture();try{
 const consumption=await f.consume(),gain=await f.count(95),loss=await f.count(93);
 const broken=await f.run({type:'perfume-bottle-stock.post',bottleProductId:'b',warehouseId:f.wh,actualQuantity:49,bottleStockReason:'breakage',reason:'Broken'});
 let report=await f.report();assert.equal(report.summary.inventoryLoss,1220);assert.equal(report.summary.inventoryGain,500);
 assert.deepEqual(new Set(report.inventoryEffects.loss.map(x=>x.documentId)),new Set([consumption,loss,broken]));assert.equal(report.inventoryEffects.gain[0].documentId,gain);
 for(const [key,field] of [['loss','inventoryLoss'],['gain','inventoryGain']])assert.equal(report.inventoryEffects[key].reduce((s,x)=>s+x.value,0),report.summary[field]);
 const profit=await buildReport(f.db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=profit&allTime=true&productId='+f.p)));
 assert.equal(profit.inventoryEffects.loss.reduce((s,x)=>s+x.value,0),profit.summary.inventoryLoss);assert.equal(profit.inventoryEffects.gain[0].documentId,gain);
 await f.cancel(loss);report=await f.report();assert.equal(report.summary.inventoryLoss,1020);assert(!report.inventoryEffects.loss.some(x=>x.documentId===loss));
 const dated=await buildReport(f.db,parseReportFilters(new URL('http://127.0.0.1/api/reports?type=overview&from=2000-01-01&to=2000-01-02')));assert.deepEqual(dated.inventoryEffects,{loss:[],gain:[]});
}finally{await f.h.close()}});

test('backup round-trip keeps a reversible consumption and linked revised report sources',async()=>{const f=await fixture();try{
 const sale=await f.sale(),old=await f.consume();await f.run({type:'decant-sale.void',documentId:sale});
 const d=await f.db.collection('documents').findOne({id:old});const edited=await f.run({type:'perfume-management.update',documentId:old,...managementInputFor(d,[]),quantity:5});
 const backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));await f.db.dropDatabase();await f.db.transaction(s=>restoreNativeBackup(f.db,backup,s));
 const r=await f.report();assert.deepEqual(r.inventoryEffects.loss.map(x=>x.documentId),[edited]);await f.cancel(edited);assert.equal((await f.get()).stocks[f.wh],100);
}finally{await f.h.close()}});

test('a backdated later sale is still identified by posting order',async()=>{const f=await fixture();try{
 const used=await f.consume(),sale=await f.sale(1);await f.db.collection('documents').updateOne({id:sale},{$set:{occurredAt:'2000-01-01T00:00:00.000Z'}});
 await assert.rejects(f.cancel(used),e=>e.dependencies.some(x=>x.documentId===sale));
}finally{await f.h.close()}});

test('unexplained quantity drift is reported as data inconsistency without invented dependencies',async()=>{const f=await fixture();try{
 const used=await f.consume(),p=await f.get();p.perfumeLots[0].remainingQuantity=80;p.perfumeLots[0].stocks[f.wh]=80;
 await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeLots:p.perfumeLots,[`stocks.${f.wh}`]:80}});
 await assert.rejects(f.cancel(used),e=>e.dependencies.length===0&&e.message.includes('مشكلة تطابق بيانات'));
 assert.equal((await f.get()).stocks[f.wh],80);
}finally{await f.h.close()}});

test('an inconsistent visible product balance cannot be reversed as a valid lot movement',async()=>{const f=await fixture();try{
 const used=await f.consume();await f.db.collection('products').updateOne({id:f.p},{$set:{[`stocks.${f.wh}`]:80}});
 await assert.rejects(f.cancel(used),e=>e.dependencies.length===0&&e.message.includes('رصيد المنتج لا يطابق'));
 assert.equal((await f.get()).stocks[f.wh],80);
}finally{await f.h.close()}});

test('stock histories filter sources, names, dates, revisions, cancellations and page boundaries before display',async()=>{const f=await fixture();try{
 const old=await f.consume(),d=await f.db.collection('documents').findOne({id:old});
 const current=await f.run({type:'perfume-management.update',documentId:old,...managementInputFor(d,[]),quantity:4});
 const count=await f.count(94);
 const get=async query=>{const response=await history(new Request('http://localhost/api/history?resource=documents&scope=perfume&'+query));assert.equal(response.status,200);return response.json()};
 let result=await get('managementKind=consumption&latest=true&status=all&q=Perfume&pageSize=1');assert.equal(result.total,1);assert.equal(result.rows[0].id,current);
 result=await get('managementKind=consumption&status=all');assert.equal(result.total,2);
 result=await get('managementKind=yield-correction&from=2000-01-01&to=2000-01-02');assert.equal(result.total,0);
 result=await get('managementKind=yield-correction');assert.equal(result.rows[0].id,count);
 await f.cancel(count);result=await get('managementKind=yield-correction&status=posted');assert.equal(result.total,0);
 result=await get('managementKind=consumption&status=all&pageSize=1&page=2');assert.equal(result.rows.length,1);assert.equal(result.totalPages,2);
 await f.db.collection('users').insertOne({id:'locked-user',isActive:true,permissions:[]});assert.equal((await history(new Request('http://localhost/api/history?scope=perfume&managementKind=consumption'))).status,401);
}finally{await f.h.close()}});
