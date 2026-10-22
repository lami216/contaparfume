import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {managementInputFor} from '../app/perfume-management.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';

async function fixture(t){
 const h=await sqliteHarness();await h.reset();t.after(()=>h.close());const db=h.db;
 await db.collection('warehouses').insertMany([{id:'w',name:'Stock',isSalesDefault:true},{id:'w2',name:'Other'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',openingBalance:10000,balance:10000,isActive:true});
 await db.collection('productCategories').insertMany([{id:'glass',name:'Glass'},{id:'perfume',name:'Perfume'}]);
 await db.collection('products').insertMany([
  {id:'b5',sku:'1',name:'5 ml bottle',perfumeForm:'bottle',decantSizeMl:5,stocks:{w:20,w2:10},openingCost:20,lastPurchaseCost:20,pieceCost:999,piecePrice:50,categoryId:'glass'},
  {id:'b10',sku:'2',name:'10 ml bottle',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:20},openingCost:30,lastPurchaseCost:30,piecePrice:60,categoryId:'glass'},
  {id:'full',sku:'3',name:'Perfume',perfumeForm:'full',stocks:{w:1},openingCost:10000,lastPurchaseCost:10000,piecePrice:15000,categoryId:'perfume'}]);
 const run=body=>db.transaction(s=>execute(db,s,body)),product=id=>db.collection('products').findOne({id}),doc=id=>db.collection('documents').findOne({id});
 const count=(reason,actualQuantity=18,more={})=>run({type:'perfume-bottle-stock.post',bottleProductId:'b5',warehouseId:'w',actualQuantity,bottleStockReason:reason,reason:'Physical count',cost:999,inventoryLoss:999,...more});
 const report=(type='overview',params={})=>buildReport(db,parseReportFilters(new URL('http://localhost/api/reports?'+new URLSearchParams({type,allTime:'true',unpaged:'true',...params}))));
 const snapshot=async()=>{const out={};for(const name of ['products','documents','stockMovements','financialMovements','paymentAccounts','counters'])out[name]=await db.collection(name).find().toArray();return out;};
 const moneyUnchanged=async()=>{assert.equal((await db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);assert.equal(await db.collection('financialMovements').countDocuments(),0);};
 return{db,run,product,doc,count,report,snapshot,moneyUnchanged};
}
for(const reason of ['breakage','damage'])test(`${reason} recognizes bottle loss at authoritative cost without cash`,async t=>{
 const f=await fixture(t),id=await f.count(reason),d=await f.doc(id);
 assert.equal((await f.product('b5')).stocks.w,18);assert.equal((await f.product('b5')).stocks.w2,10);
 assert.equal(d.bottleStockReason,reason);assert.equal(d.managementInput.bottleStockReason,reason);assert.equal(d.managementInput.cost,20);
 assert.equal(d.lines[0].unitPrice,20);assert.equal(d.inventoryLoss,40);assert.equal(d.lines[0].inventoryLoss,40);assert.equal(d.inventoryGain,0);
 assert.equal(d.bookValueBefore,400);assert.equal(d.bookValueAfter,360);
 const r=await f.report(),p=await f.report('profit');assert.equal(r.summary.currentInventoryValue,11160);assert.equal(r.summary.salesProfit,0);assert.equal(r.summary.inventoryLoss,40);assert.equal(r.summary.netOperatingResult,-40);assert.equal(p.summary.netProfitAfterInventoryLoss,-40);
 await f.moneyUnchanged();
});
for(const actual of [18,22])test(`entry correction to ${actual} changes stock value without profit or loss`,async t=>{
 const f=await fixture(t),id=await f.count('correction',actual),d=await f.doc(id);
 assert.equal(d.inventoryLoss,0);assert.equal(d.inventoryGain,0);assert.equal((await f.product('b5')).stocks.w,actual);
 const r=await f.report();assert.equal(r.summary.currentInventoryValue,11200+(actual-20)*20);assert.equal(r.summary.netOperatingResult,0);assert.equal(r.summary.inventoryLoss,0);assert.equal(r.summary.inventoryGain,0);await f.moneyUnchanged();
});
test('quantity edit replaces the original loss once and void restores all original stock and profit',async t=>{
 const f=await fixture(t),first=await f.count('breakage'),before=await f.doc(first);
 const next=await f.run({type:'perfume-management.update',documentId:first,expectedRevision:0,...managementInputFor(before,[]),actualQuantity:17});
 const d=await f.doc(next);assert.equal(d.revision,1);assert.equal(d.replacesDocumentId,first);assert.equal((await f.doc(first)).replacedByDocumentId,next);assert.equal((await f.doc(first)).status,'voided');assert.deepEqual((await f.doc(first)).lines,before.lines);
 assert.equal((await f.product('b5')).stocks.w,17);assert.equal(d.inventoryLoss,60);assert.equal((await f.report()).summary.inventoryLoss,60);
 await f.run({type:'perfume-management.void',documentId:next,expectedRevision:1});assert.equal((await f.product('b5')).stocks.w,20);assert.equal((await f.report()).summary.inventoryLoss,0);assert.equal((await f.report()).summary.currentInventoryValue,11200);await f.moneyUnchanged();
 const stock=await f.report('stock',{productId:'b5'});assert.equal(stock.rows.reduce((sum,row)=>sum+row.change,0),0);
});
test('reclassifying loss as entry correction removes its profit effect, and the reverse recognizes it once',async t=>{
 const f=await fixture(t),first=await f.count('damage'),input=managementInputFor(await f.doc(first),[]);
 const correction=await f.run({type:'perfume-management.update',documentId:first,expectedRevision:0,...input,bottleStockReason:'correction'});assert.equal((await f.product('b5')).stocks.w,18);assert.equal((await f.report()).summary.inventoryLoss,0);
 const again=await f.run({type:'perfume-management.update',documentId:correction,expectedRevision:1,...input,bottleStockReason:'breakage'});assert.equal((await f.product('b5')).stocks.w,18);assert.equal((await f.report()).summary.inventoryLoss,40);
 await assert.rejects(f.run({type:'perfume-management.void',documentId:first,expectedRevision:0}),/ملغاة/);
 await f.run({type:'perfume-management.void',documentId:again,expectedRevision:2});assert.equal((await f.report()).summary.inventoryLoss,0);assert.equal((await f.product('b5')).stocks.w,20);
});
test('invalid reclassification rolls back the old count, its loss and every movement',async t=>{
 const f=await fixture(t),id=await f.count('correction',22),before=await f.snapshot();
 await assert.rejects(f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(await f.doc(id),[]),bottleStockReason:'damage'}),/كمية فعلية أقل/);assert.deepEqual(await f.snapshot(),before);
});
test('missing or invalid classification and invalid actual quantities leave no partial transaction',async t=>{
 const f=await fixture(t);
 for(const value of [undefined,'','other','__proto__',true]){const before=await f.snapshot();await assert.rejects(f.count(value),/اختر سبب/);assert.deepEqual(await f.snapshot(),before)}
 for(const value of ['',null,true,-1,1.5,NaN,Infinity]){const before=await f.snapshot();await assert.rejects(f.count('breakage',value));assert.deepEqual(await f.snapshot(),before)}
});
test('physical loss cannot increase stock or post a zero difference',async t=>{
 const f=await fixture(t);for(const reason of ['breakage','damage'])for(const actual of [20,22]){const before=await f.snapshot();await assert.rejects(f.count(reason,actual),/كمية فعلية أقل/);assert.deepEqual(await f.snapshot(),before)}
 await assert.rejects(f.count('correction',20),/لا يوجد تغيير/);
});
test('physical loss with unknown cost is rejected even when a catalog reference cost exists',async t=>{
 const f=await fixture(t);await f.db.collection('products').updateOne({id:'b5'},{$set:{openingCost:null,lastPurchaseCost:null}});
 const before=await f.snapshot();await assert.rejects(f.count('breakage'),/لا توجد تكلفة معتمدة/);assert.deepEqual(await f.snapshot(),before);
 await f.count('correction');assert.equal((await f.product('b5')).stocks.w,18);assert.equal((await f.report()).summary.inventoryLoss,0);
});
test('edits retain the original unit cost when valuation metadata later changes',async t=>{
 const f=await fixture(t),id=await f.count('damage');await f.db.collection('products').updateOne({id:'b5'},{$set:{openingCost:30,lastPurchaseCost:30}});
 const next=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(await f.doc(id),[]),actualQuantity:17,cost:999});
 assert.equal((await f.doc(next)).lines[0].unitPrice,20);assert.equal((await f.doc(next)).inventoryLoss,60);assert.equal((await f.report()).summary.inventoryLoss,60);
});
test('later sales block reinterpretation of an absolute count; void reverses only its delta',async t=>{
 const f=await fixture(t),id=await f.count('damage');
 const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:'b5',quantity:1,unitPrice:50}]});
 const before=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(await f.doc(id),[]),actualQuantity:17}),/تغير رصيد الزجاج/);assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'perfume-management.void',documentId:id,expectedRevision:0});assert.equal((await f.product('b5')).stocks.w,19);assert.equal((await f.report()).summary.inventoryLoss,0);assert.equal((await f.report()).summary.netOperatingResult,30);
 await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.product('b5')).stocks.w,20);assert.equal((await f.report()).summary.netOperatingResult,0);
});
test('later purchases also block reinterpretation of an old absolute count',async t=>{
 const f=await fixture(t),id=await f.count('breakage');const purchase=await f.run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:'b5',quantity:2,unitPrice:30}]});
 const before=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(await f.doc(id),[]),actualQuantity:17}),/تغير رصيد الزجاج/);assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'decant-purchase.void',documentId:purchase});await f.run({type:'perfume-management.void',documentId:id,expectedRevision:0});assert.equal((await f.product('b5')).stocks.w,20);
});
test('a correction increase cannot be reversed after its stock has been consumed',async t=>{
 const f=await fixture(t),id=await f.count('correction',22);const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:'b5',quantity:21,unitPrice:50}]});
 await assert.rejects(f.run({type:'perfume-management.void',documentId:id,expectedRevision:0}),/تم التصرف فيه/);assert.equal((await f.product('b5')).stocks.w,1);
 await f.run({type:'decant-sale.void',documentId:sale});await f.run({type:'perfume-management.void',documentId:id,expectedRevision:0});assert.equal((await f.product('b5')).stocks.w,20);
});
test('loss filters by bottle, category and reporting period agree without cross-contaminating perfume',async t=>{
 const f=await fixture(t),id=await f.count('breakage');await f.db.collection('documents').updateOne({id},{$set:{occurredAt:'2026-01-03T12:00:00.000Z'}});
 for(const params of [{productId:'b5'},{categoryId:'glass'},{allTime:'false',from:'2026-01-01',to:'2026-01-31'}])assert.equal((await f.report('profit',params)).summary.inventoryLoss,40);
 for(const params of [{productId:'b10'},{categoryId:'perfume'},{allTime:'false',from:'2026-02-01',to:'2026-02-28'}])assert.equal((await f.report('profit',params)).summary.inventoryLoss,0);
});
test('legacy counts stay non-profit corrections and hydrate with an explicit reason for editing',async t=>{
 const f=await fixture(t),id=await f.count('correction');
 await f.db.collection('documents').updateOne({id},{$unset:{managementInput:'',bottleStockReason:'',perfumeStockOperationType:'',inventoryLoss:'',inventoryGain:''}});
 const original=await f.doc(id),input=managementInputFor(original,[]);assert.equal(input.bottleStockReason,'correction');assert.equal(input.bottleProductId,'b5');assert.equal(input.actualQuantity,18);assert.equal((await f.report()).summary.inventoryLoss,0);assert.deepEqual(await f.doc(id),original);
 const next=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...input,bottleStockReason:'damage'});assert.equal((await f.doc(next)).inventoryLoss,40);assert.equal((await f.report()).summary.inventoryLoss,40);
});
test('a stale edit and repeated void do not change inventory or multiply the loss',async t=>{
 const f=await fixture(t),id=await f.count('breakage'),before=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.void',documentId:id,expectedRevision:9}),/تغيرت العملية/);assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'perfume-management.void',documentId:id,expectedRevision:0});const after=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.void',documentId:id,expectedRevision:1}),/ملغاة/);assert.deepEqual(await f.snapshot(),after);
});
test('generic adjustment endpoints cannot bypass classification and the bottle lifecycle',async t=>{
 const f=await fixture(t),initial=await f.snapshot();await assert.rejects(f.run({type:'adjustment.post',warehouseId:'w',reason:'bypass',bottleStockReason:'breakage',lines:[{productId:'b5',actualQuantity:18}]}),/جرد زجاج التقسيمات/);assert.deepEqual(await f.snapshot(),initial);
 const id=await f.count('breakage'),before=await f.snapshot();for(const type of ['adjustment.update','adjustment.void'])await assert.rejects(f.run({type,documentId:id,warehouseId:'w',reason:'bypass',lines:[{productId:'b5',actualQuantity:20}]}),/إدارة التقسيمات/);assert.deepEqual(await f.snapshot(),before);
});
test('backup restoration retains classification, cost snapshots, loss and linked revisions',async t=>{
 const f=await fixture(t),id=await f.count('breakage'),next=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,...managementInputFor(await f.doc(id),[]),bottleStockReason:'damage',actualQuantity:17});
 const report=await f.report(),backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));await f.db.transaction(s=>restoreNativeBackup(f.db,backup,s));assert.deepEqual((await f.report()).summary,report.summary);assert.equal((await f.doc(next)).bottleStockReason,'damage');assert.equal((await f.doc(next)).inventoryLoss,60);assert.equal((await f.doc(id)).replacedByDocumentId,next);
 await f.run({type:'perfume-management.void',documentId:next,expectedRevision:1});assert.equal((await f.report()).summary.inventoryLoss,0);
});
test('editing the counted bottle or warehouse restores the original target before applying the new one',async t=>{
 const f=await fixture(t),id=await f.count('breakage');
 const next=await f.run({type:'perfume-management.update',documentId:id,expectedRevision:0,bottleProductId:'b10',warehouseId:'w',actualQuantity:18,bottleStockReason:'damage',reason:'Wrong bottle selected'});
 assert.equal((await f.product('b5')).stocks.w,20);assert.equal((await f.product('b10')).stocks.w,18);assert.equal((await f.doc(next)).inventoryLoss,60);
 const moved=await f.run({type:'perfume-management.update',documentId:next,expectedRevision:1,bottleProductId:'b5',warehouseId:'w2',actualQuantity:9,bottleStockReason:'breakage',reason:'Wrong location selected'});
 assert.equal((await f.product('b10')).stocks.w,20);assert.equal((await f.product('b5')).stocks.w2,9);assert.equal((await f.report()).summary.inventoryLoss,20);
 await f.run({type:'perfume-management.void',documentId:moved,expectedRevision:2});assert.equal((await f.product('b5')).stocks.w2,10);assert.equal((await f.report()).summary.inventoryLoss,0);
});
test('bottle count loss is separate from bottles already included in the decant sale cost',async t=>{
 const f=await fixture(t);await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,priceBasisMl:5,salePrice:600});const p=await f.db.collection('products').findOne({perfumeForm:'decant'});
 const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:p.id,quantity:2,fillMl:5,bottleProductId:'b5',unitPrice:600}]});const count=await f.count('breakage',16);
 let r=await f.report();assert.equal(r.summary.salesCost,1040);assert.equal(r.summary.salesProfit,160);assert.equal(r.summary.inventoryLoss,40);assert.equal(r.summary.netOperatingResult,120);
 await f.run({type:'decant-sale.void',documentId:sale});await f.run({type:'perfume-management.void',documentId:count,expectedRevision:0});r=await f.report();assert.equal((await f.product('b5')).stocks.w,20);assert.equal(r.summary.netOperatingResult,0);assert.equal(r.summary.currentInventoryValue,11200);
});
