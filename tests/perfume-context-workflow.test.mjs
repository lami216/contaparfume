import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {GET as history} from '../app/api/history/route.ts';
import {GET as bootstrap} from '../app/api/bootstrap/route.ts';
import {createSession} from '../lib/auth.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {relatedPerfumeDocuments,currentPerfumeOperations} from '../app/perfume-activity.ts';
import {resolvePerfumeDefaults} from '../app/perfume-volume.ts';
import {managementPreviewLot} from '../app/perfume-management.ts';

async function fixture(t){
 const h=await sqliteHarness();await h.reset();t.after(()=>h.close());const db=h.db;
 await db.collection('warehouses').insertMany([{id:'w',name:'Main',isSalesDefault:true},{id:'w2',name:'Other'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',openingBalance:10000,balance:10000,isActive:true});
 await db.collection('products').insertMany([
  {id:'full',sku:'1',name:'Perfume',perfumeForm:'full',stocks:{w:3},openingCost:1000,lastPurchaseCost:1000,pieceCost:1000,piecePrice:1500},
  {id:'bottle',sku:'2',name:'Bottle',perfumeForm:'bottle',stocks:{w:20},openingCost:5,lastPurchaseCost:5,pieceCost:5,decantSizeMl:10},
 ]);
 const run=body=>db.transaction(session=>execute(db,session,body));
 const product=id=>db.collection('products').findOne({id}),doc=id=>db.collection('documents').findOne({id});
 const split=async()=>{const id=await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:150});return doc(id)};
 const report=async()=>(await buildReport(db,parseReportFilters(new URL('http://localhost/api/reports?type=overview&allTime=true')))).summary;
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts','appSettings'].map(name=>db.collection(name).find().toArray()));
 const get=async(params,user)=>{const response=await history(new Request('http://localhost/api/history?'+params,{headers:user?{cookie:`conta_session=${createSession({principalType:'user',userId:user})}`}:{}}));assert.equal(response.status,200);return response.json()};
 return {db,run,product,doc,split,report,snapshot,get};
}
test('catalog creation, rename, archive and restore are administrative events without business documents',async t=>{
 const f=await fixture(t),before=await f.report();const id=await f.run({type:'perfume-bottle.create',name:'Empty catalog',sizeMl:10,cost:5});
 await f.run({type:'perfume-bottle.update',id,name:'Renamed',sizeMl:12,cost:6});await f.run({type:'perfume-bottle.archive',id});await f.run({type:'perfume-bottle.restore',id});
 assert.equal(await f.db.collection('documents').countDocuments(),0);assert.equal(await f.db.collection('stockMovements').countDocuments(),0);assert.equal(await f.db.collection('auditEvents').countDocuments(),4);
 assert.equal((await f.product(id)).name,'Renamed');assert.equal((await f.product(id)).isArchived,false);assert.deepEqual(await f.report(),before);
});
test('voiding an old BDEF metadata edit restores its previous metadata and preserves real stock and purchase cost',async t=>{
 const f=await fixture(t);await f.db.collection('products').updateOne({id:'bottle'},{$set:{name:'Changed',decantSizeMl:12,pieceCost:7}});
 const before={name:'Bottle',sizeMl:10,cost:5,isArchived:false},after={name:'Changed',sizeMl:12,cost:7,isArchived:false};
 await f.db.collection('documents').insertOne({id:'old-def',number:'BDEF-old',kind:'adjustment',status:'posted',perfumeManagementType:'bottle',managementProductId:'bottle',bottleDefinitionBefore:before,bottleDefinitionAfter:after,lines:[{productId:'bottle',quantity:0}],total:0});
 await f.run({type:'perfume-management.void',documentId:'old-def'});const p=await f.product('bottle');
 assert.equal(p.name,'Bottle');assert.equal(p.decantSizeMl,10);assert.equal(p.stocks.w,20);assert.equal(p.lastPurchaseCost,5);assert.equal(p.isArchived,false);assert.equal((await f.doc('old-def')).status,'voided');
});
test('old catalog cancellation rejects stale metadata atomically and remains available by document lookup',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertOne({id:'old-def',number:'BDEF-old',kind:'adjustment',status:'posted',perfumeManagementType:'bottle',managementProductId:'bottle',bottleDefinitionBefore:{name:'Prior',sizeMl:10,cost:5,isArchived:false},bottleDefinitionAfter:{name:'Stale',sizeMl:10,cost:5,isArchived:false},lines:[{productId:'bottle',quantity:0}],total:0});
 const before=await f.snapshot();await assert.rejects(f.run({type:'perfume-management.void',documentId:'old-def'}),/تغير تعريف/);assert.deepEqual(await f.snapshot(),before);
 assert.equal((await f.get('resource=documents')).rows.length,0);assert.equal((await f.get('resource=documents&id=old-def')).rows[0].id,'old-def');
});
test('zero closure is recorded once, repeated return or count is rejected, and void permits a genuine fresh closure',async t=>{
 const f=await fixture(t),s=await f.split();await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:s.decantProductId,quantity:10,fillMl:10,bottleProductId:'bottle',unitPrice:150}]});
 const input={decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',actualQuantity:0};const closed=await f.run({type:'perfume-recombine.post',...input});const before=await f.snapshot();
 for(const type of ['perfume-recombine.post','perfume-lot-correct.post'])await assert.rejects(f.run({type,...input}),/مغلقة بالفعل/);
 assert.deepEqual(await f.snapshot(),before);await f.run({type:'perfume-management.void',documentId:closed});await f.run({type:'perfume-recombine.post',...input});
 assert.equal((await f.report()).inventoryLoss,0);
});
test('new general invoice and archive paths cannot bypass liquid allocation or classified glass loss',async t=>{
 const f=await fixture(t),s=await f.split(),before=await f.snapshot();
 for(const type of ['sale.post','purchase.post','sale.update','purchase.update'])for(const productId of [s.decantProductId,'bottle'])await assert.rejects(f.run({type,warehouseId:'w',paymentMethod:'cash',lines:[{productId,quantity:1,piecePrice:10,unitPrice:10}]}),/فاتورة التقسيمات/);
 for(const id of [s.decantProductId,'bottle'])for(const type of ['product.delete','product.stock-zero'])await assert.rejects(f.run({type,id,zeroStock:true}),/تحديد سبب/);
 assert.deepEqual(await f.snapshot(),before);
 const count=await f.run({type:'perfume-bottle-stock.post',bottleProductId:'bottle',warehouseId:'w',actualQuantity:0,bottleStockReason:'breakage',reason:'Broken'});
 await f.run({type:'perfume-bottle.archive',id:'bottle'});await f.run({type:'perfume-bottle.restore',id:'bottle'});assert.equal((await f.report()).inventoryLoss,100);
 await f.run({type:'perfume-management.void',documentId:count});assert.equal((await f.product('bottle')).stocks.w,20);assert.equal((await f.report()).inventoryLoss,0);
});
test('default capacity follows bottle selection and metadata changes without rewriting historical fills or costs',async t=>{
 const f=await fixture(t),s=await f.split();await f.run({type:'perfume-defaults.update',bottleProductId:'bottle'});assert.deepEqual(resolvePerfumeDefaults({bottleProductId:'bottle',fillMl:5},[await f.product('bottle')]),{bottleProductId:'bottle',fillMl:10});
 const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:s.decantProductId,quantity:1,fillMl:5,bottleProductId:'bottle',unitPrice:100}]});const original=await f.doc(sale),r=await f.report();
 await f.run({type:'perfume-bottle.update',id:'bottle',name:'Larger',sizeMl:12,cost:7});assert.deepEqual(await f.doc(sale),original);assert.equal((await f.db.collection('appSettings').findOne({_id:'perfume-defaults'})).fillMl,12);assert.deepEqual(await f.report(),r);
 const boot=await bootstrap(new Request('http://localhost/api/bootstrap'));assert.equal((await boot.json()).perfumeDefaults.fillMl,12);
 await f.run({type:'decant-sale.void',documentId:sale});assert.equal((await f.product(s.decantProductId)).stocks.w,100);assert.equal((await f.product('bottle')).stocks.w,20);
});
test('related activity separates lots and includes zero closure, transfer, returned partial sale and all bottle uses',()=>{
 const docs=[{id:'split',kind:'adjustment',perfumeManagementType:'split',perfumeLotId:'a',decantProductId:'p',lines:[{productId:'p',quantity:100}]},{id:'sale-a',kind:'decant-sale',lines:[{productId:'p',quantity:1,bottleProductId:'b',perfumeAllocations:[{lotId:'a',quantity:5}]}]},{id:'sale-b',kind:'decant-sale',lines:[{productId:'p',quantity:1,perfumeAllocations:[{lotId:'b',quantity:5}]}]},{id:'transfer',kind:'transfer',lines:[{productId:'p',quantity:5,perfumeTransferAllocations:[{lotId:'a',quantity:5}]}]},{id:'closed',kind:'adjustment',perfumeManagementType:'recombine',perfumeLotId:'a',lines:[]},{id:'returned',kind:'adjustment',perfumeManagementType:'recombine',perfumeLotId:'a',partialProductId:'partial',lines:[]},{id:'partial-sale',kind:'sale',lines:[{productId:'partial',quantity:1}]},{id:'catalog',kind:'adjustment',perfumeManagementType:'bottle',managementProductId:'b',lines:[{productId:'b',quantity:0}]}];
 assert.deepEqual(relatedPerfumeDocuments(docs,{productId:'p',lotId:'a',conversionId:'split'}).map(d=>d.id),['split','sale-a','transfer','closed','returned','partial-sale']);assert.deepEqual(relatedPerfumeDocuments(docs,{productId:'b'}).map(d=>d.id),['sale-a']);
 assert.deepEqual(currentPerfumeOperations([{id:'old',status:'voided',replacedByDocumentId:'new'},{id:'new',status:'posted'},{id:'cancelled',status:'voided'}]).map(d=>d.id),['new']);assert.equal(currentPerfumeOperations([{id:'cancelled',status:'voided'}],true).length,1);
 const revisions=[{id:'original',kind:'adjustment',perfumeManagementType:'split',perfumeLotId:'old-lot',replacedByDocumentId:'revised',lines:[{productId:'old-product',quantity:100}]},{id:'revised',kind:'adjustment',perfumeManagementType:'split',perfumeLotId:'new-lot',replacesDocumentId:'original',lines:[{productId:'new-product',quantity:120}]}];assert.deepEqual(relatedPerfumeDocuments(revisions,{productId:'new-product',lotId:'new-lot'}).map(d=>d.id),['original','revised']);
});
test('scoped history preserves per-source authorization, hides old definitions and finds warehouse transfers and partial sales',async t=>{
 const f=await fixture(t),s=await f.split();const transfer=await f.run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'w2',lines:[{productId:s.decantProductId,quantity:5}]});
 await f.db.collection('users').insertMany([{id:'owner',isActive:true,name:'Owner'},{id:'viewer',isActive:true,username:'viewer',name:'Viewer',permissions:['perfume.divisions.view']}]);
 await f.db.collection('documents').insertMany([{id:'unrelated',kind:'sale',status:'posted',lines:[{productId:'full',quantity:1}]},{id:'old-def',kind:'adjustment',status:'posted',perfumeManagementType:'bottle',managementProductId:'bottle',lines:[{productId:'bottle',quantity:0}]}]);
 const request=params=>history(new Request('http://localhost/api/history?'+params,{headers:{cookie:`conta_session=${createSession({principalType:'owner'})}`}}));
 const payload=await (await request('resource=documents&scope=perfume')).json();assert.deepEqual(new Set(payload.rows.map(d=>d.id)),new Set([s.id,transfer]));
 const limited=await f.get('resource=documents&scope=perfume&productId='+s.decantProductId+'&lotId='+s.perfumeLotId,'viewer');assert.deepEqual(limited.rows.map(d=>d.id),[s.id]);
});
test('general history presents migrated quantities in ml and neutralizes technical unit changes without rewriting storage or value',async t=>{
 const f=await fixture(t);await f.db.collection('products').insertOne({id:'old',sku:'90',name:'Old',perfumeForm:'decant',stocks:{w:4},pieceCost:25,perfumeLots:[{id:'old-lot',sourceProductId:'full',sourceProductName:'Old',originalQuantity:4,remainingQuantity:4,liquidUnitCost:25,landedUnitCost:25,stocks:{w:4},conversionDocumentId:'old-split',createdAt:'2026-01-01'}]});
 await f.db.collection('stockMovements').insertOne({id:'old-movement',documentId:'old-split',productId:'old',warehouseId:'w',type:'perfume-split-in',quantityDelta:4,balanceBefore:0,balanceAfter:4,occurredAt:'2026-01-01'});
 const before=await f.report(),id=await f.run({type:'perfume-volume.migrate',decantProductId:'old',legacyPortionMl:10}),rows=(await f.get('resource=stockMovements')).rows;
 assert.equal(rows.find(r=>r.id==='old-movement').quantityDelta,40);assert.equal(rows.find(r=>r.id==='old-movement').quantityUnit,'ml');assert.equal(rows.find(r=>r.documentId===id).quantityDelta,0);
 assert.equal((await f.db.collection('stockMovements').findOne({id:'old-movement'})).quantityDelta,4);assert.equal((await f.report()).currentInventoryValue,before.currentInventoryValue);
 assert.equal((await f.get('resource=stockMovements&scope=perfume')).rows.find(r=>r.id==='old-movement').quantityDelta,40);
});
test('complete composed lifecycle preserves report values through revisions and reversals in context order',async t=>{
 const f=await fixture(t),baseline=await f.report(),s=await f.split();const sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:s.decantProductId,quantity:2,fillMl:5,bottleProductId:'bottle',unitPrice:100}]});
 const count=await f.run({type:'perfume-lot-correct.post',decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',actualQuantity:88,reason:'Measured'});let r=await f.report();assert.equal(r.salesProfit,90);assert.equal(r.inventoryLoss,20);assert.equal(r.netOperatingResult,70);
 const revised=await f.run({type:'perfume-management.update',documentId:count,expectedRevision:0,decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',actualQuantity:91,reason:'Recount'});r=await f.report();assert.equal(r.inventoryLoss,0);assert.equal(r.inventoryGain,10);assert.equal(r.netOperatingResult,100);
 await f.run({type:'perfume-management.void',documentId:revised});await f.run({type:'decant-sale.void',documentId:sale});await f.run({type:'perfume-management.void',documentId:s.id});r=await f.report();for(const key of ['sales','salesProfit','inventoryLoss','inventoryGain','currentInventoryValue','currentAccountsBalance','netOperatingResult'])assert.equal(r[key],baseline[key],key);
});
test('editing count and return previews uses the original baseline rather than the current reduced or closed lot',async t=>{
 const f=await fixture(t),s=await f.split(),input={decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',actualQuantity:95,reason:'Count'};
 const id=await f.run({type:'perfume-lot-correct.post',...input}),d=await f.doc(id),current=(await f.product(s.decantProductId)).perfumeLots[0];
 assert.equal(managementPreviewLot(d,s.decantProductId,s.perfumeLotId,'w',current).stocks.w,100);assert.equal(managementPreviewLot(d,s.decantProductId,s.perfumeLotId,'w2',current),current);
 await f.run({type:'perfume-management.void',documentId:id});const returned=await f.run({type:'perfume-recombine.post',...input,salePrice:1500});const closed=(await f.product(s.decantProductId)).perfumeLots[0];assert.equal(closed.remainingQuantity,0);assert.equal(managementPreviewLot(await f.doc(returned),s.decantProductId,s.perfumeLotId,'w',closed).remainingQuantity,100);
});
