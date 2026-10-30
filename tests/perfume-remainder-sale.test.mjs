import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute,POST} from '../app/api/command/route.ts';
import {createSession} from '../lib/auth.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 const previousProfile=process.env.ALKARNA_USER_DATA;process.env.ALKARNA_USER_DATA=h.directory;
 t.after(()=>{if(previousProfile===undefined)delete process.env.ALKARNA_USER_DATA;else process.env.ALKARNA_USER_DATA=previousProfile});
 await db.collection('warehouses').insertMany([{_id:'w',name:'Remainder source',isSalesDefault:true},{_id:'other',name:'Other warehouse'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertOne({id:'full',sku:'1',name:'Synthetic perfume',perfumeForm:'full',stocks:{w:2},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500});
 const run=body=>db.transaction(session=>execute(db,session,body));
 const split=()=>run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 const splitId=await split(),liquid=await db.collection('products').findOne({perfumeForm:'decant'}),productId=liquid.id,lotId=liquid.perfumeLots[0].id;
 const input={productId,lotId,warehouseId:'w',quantityMl:25.5,totalPrice:500,paymentMethod:'cash'};
 const sale=(extra={})=>run({type:'perfume-remainder-sale.post',...input,...extra});
 const update=(documentId,extra={})=>run({type:'perfume-remainder-sale.update',documentId,expectedRevision:0,...input,...extra});
 const doc=id=>db.collection('documents').findOne({id}),product=()=>db.collection('products').findOne({id:productId});
 const snapshot=()=>Promise.all(['products','warehouses','parties','documents','stockMovements','financialMovements','paymentAccounts','counters','auditEvents','commandReceipts'].map(name=>db.collection(name).find().toArray()));
 const report=type=>buildReport(db,parseReportFilters(new URL(`http://local/api/reports?type=${type}&allTime=true`)));
 return{h,db,run,split,splitId,productId,lotId,input,sale,update,doc,product,snapshot,report};
}

test('remainder sale posts one ordinary decant invoice with authoritative ml cost and no glass or partial product',async t=>{
 const f=await fixture(t),before=await f.product(),count=await f.db.collection('products').countDocuments(),id=await f.sale({
  costAtSale:1,perfumeAllocations:[{lotId:'spoof',quantity:1,unitCost:0}],bottleProductId:'spoof',remainingValue:1,note:' Synthetic sale note ',
 }),document=await f.doc(id),line=document.lines[0],after=await f.product();
 assert.equal(document.kind,'decant-sale');assert.equal(document.perfumeSaleMode,'remainder');assert.equal(document.perfumeSaleSource,'perfume-remainder');
 assert.equal(document.title,'بيع المتبقي');assert.equal(document.parentDocumentId,f.splitId);assert.equal(document.perfumeLotId,f.lotId);
 assert.equal(document.note,'Synthetic sale note');
 assert.equal(document.total,500);assert.equal(document.paidTotal,500);assert.equal(document.dueTotal,0);assert.equal(document.cashAmount,500);
 assert.equal(line.quantity,1);assert.equal(line.liquidQuantityMl,25.5);assert.equal(line.unitPrice,500);assert.equal(line.lineTotal,500);
 assert.equal(line.costAtSale,255);assert.equal(line.grossProfit,245);assert.match(line.description,/25\.5 مل/);
 for(const key of ['bottleProductId','bottleQuantity','bottleUnitCost','fillMl'])assert.equal(line[key],undefined);
 assert.deepEqual(line.perfumeAllocations,[{lotId:f.lotId,warehouseId:'w',quantity:25.5,unitCost:10,quantityUnit:'ml'}]);
 assert.equal(after.stocks.w,74.5);assert.equal(after.perfumeLots[0].stocks.w,74.5);assert.equal(after.perfumeLots[0].remainingQuantity,74.5);
 assert.equal(before.piecePrice,after.piecePrice);assert.equal(await f.db.collection('products').countDocuments(),count);assert.equal(await f.db.collection('products').findOne({perfumeForm:'partial'}),null);
 const movements=await f.db.collection('stockMovements').find({documentId:id}).toArray();assert.equal(movements.length,1);assert.equal(movements[0].quantityDelta,-25.5);assert.equal(movements[0].type,'decant-sale-liquid');assert.equal(movements[0].quantityUnit,'ml');
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10500);
 const sales=await f.report('sales');assert.equal(sales.summary.netSales,500);assert.equal(sales.summary.cost,255);assert.equal(sales.summary.profit,245);
 const itemSales=await buildReport(f.db,parseReportFilters(new URL(`http://local/api/reports?type=sales&allTime=true&productId=${f.productId}`)));assert.equal(itemSales.rows[0].liquidQuantityMl,25.5);
 const overview=await f.report('overview');assert.equal(overview.summary.inventoryLoss,0);assert.equal(overview.summary.inventoryGain,0);
 assert.equal((await f.report('financial')).summary.incoming,500);
});

test('remainder sale selects its exact lot and explicit warehouse instead of FIFO or sales default',async t=>{
 const f=await fixture(t);
 await f.run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'other',lines:[{productId:f.productId,quantity:20}]});
 const id=await f.sale({warehouseId:'other',quantityMl:12.345,totalPrice:600}),doc=await f.doc(id),p=await f.product();
 assert.equal(doc.warehouseId,'other');assert.equal(doc.lines[0].perfumeAllocations[0].warehouseId,'other');assert.equal(p.stocks.other,7.655);assert.equal(p.stocks.w,80);
 await f.run({type:'decant-sale.void',documentId:id});const restored=await f.product();assert.equal(restored.stocks.other,20);assert.equal(restored.stocks.w,80);
});

test('historically overlapping lots are sold only by explicit lot and preserve that lot cost on price-only edits',async t=>{
 const f=await fixture(t),product=await f.product(),second={...structuredClone(product.perfumeLots[0]),id:'synthetic-overlapping-lot',originalQuantity:20,remainingQuantity:20,liquidUnitCost:30,landedUnitCost:30,stocks:{w:20},createdAt:'2099-01-01T00:00:00Z'};
 await f.db.collection('products').updateOne({id:f.productId},{$set:{perfumeLots:[...product.perfumeLots,second],'stocks.w':120}});
 const id=await f.sale({lotId:second.id,quantityMl:7,totalPrice:400,note:'Preserved remainder note'}),doc=await f.doc(id);assert.equal(doc.lines[0].costAtSale,210);assert.equal(doc.lines[0].perfumeAllocations[0].lotId,second.id);
 await f.db.collection('products').updateOne({id:f.productId},{$set:{pieceCost:999,lastPurchaseCost:999}});
 await f.update(id,{lotId:second.id,quantityMl:7,totalPrice:500});const changed=await f.doc(id),after=await f.product();assert.equal(changed.note,'Preserved remainder note');assert.equal(changed.lines[0].costAtSale,210);assert.equal(after.perfumeLots[0].remainingQuantity,100);assert.equal(after.perfumeLots[1].remainingQuantity,13);
 await f.run({type:'decant-sale.void',documentId:id,expectedRevision:1});const restored=await f.product();assert.equal(restored.perfumeLots[0].remainingQuantity,100);assert.equal(restored.perfumeLots[1].remainingQuantity,20);assert.equal(restored.stocks.w,120);
});

test('separate remainder sales can be reversed out of order without changing the other invoice or its allocations',async t=>{
 const f=await fixture(t),first=await f.sale({quantityMl:30}),second=await f.sale({quantityMl:20,totalPrice:350}),secondDoc=await f.doc(second);
 await f.run({type:'decant-sale.void',documentId:first});assert.equal((await f.product()).stocks.w,80);assert.deepEqual(await f.doc(second),secondDoc);assert.equal((await f.report('sales')).summary.netSales,350);assert.equal((await f.report('sales')).summary.cost,200);
 await f.run({type:'decant-sale.void',documentId:second});assert.equal((await f.product()).stocks.w,100);
});

test('remainder cancellation reactivates an archived exhausted liquid and warehouse and preserves returned customer credit',async t=>{
 const f=await fixture(t),customer=await f.run({type:'party.create',partyType:'customer',name:'Synthetic archived customer'}),id=await f.sale({quantityMl:100,paymentMethod:'note',partyId:customer});
 await f.run({type:'party-cash.post',partyId:customer,direction:'receive',paymentMethod:'cash',amount:500});await f.run({type:'party.delete',id:customer});
 await f.run({type:'transfer.post',fromWarehouseId:'w',toWarehouseId:'other',lines:[{productId:'full',quantity:1}]});
 await f.run({type:'warehouse.default',warehouseId:'other'});await f.run({type:'warehouse.delete',id:'w'});
 // Historical archive fixture: the supported archive operation refuses live liquid.
 await f.db.collection('products').updateOne({id:f.productId},{$set:{isArchived:true,archivedAt:'2026-01-01'}});
 await f.run({type:'decant-sale.void',documentId:id});const restored=await f.product(),party=await f.db.collection('parties').findOne({id:customer});
 assert.equal(restored.stocks.w,100);assert.equal(restored.isArchived,false);assert.equal((await f.db.collection('warehouses').findOne({_id:'w'})).isArchived,false);assert.equal(party.isArchived,false);assert.equal(party.payable,500);
});

test('remainder price/payment edits keep original allocation cost and normal financial audit; void exactly restores stock',async t=>{
 const f=await fixture(t),initial=await f.product(),id=await f.sale(),before=await f.doc(id);
 const customer=await f.run({type:'party.create',partyType:'customer',name:'Synthetic remainder customer'});
 await f.update(id,{paymentMethod:'note',partyId:customer,totalPrice:700,note:' Updated remainder note '});const edited=await f.doc(id);
 assert.equal(edited.id,before.id);assert.equal(edited.number,before.number);assert.equal(edited.sequence,before.sequence);assert.equal(edited.revision,1);assert.equal(edited.editHistory.length,1);
 assert.equal(edited.note,'Updated remainder note');
 assert.equal(edited.lines[0].costAtSale,255);assert.deepEqual(edited.lines[0].perfumeAllocations,before.lines[0].perfumeAllocations);assert.equal(edited.lines[0].grossProfit,445);
 assert.equal((await f.db.collection('parties').findOne({id:customer})).receivable,700);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
 assert.equal((await f.report('sales')).summary.profit,445);assert.equal((await f.report('financial')).summary.incoming,0);
 const unchanged=await f.snapshot();await assert.rejects(f.update(id,{totalPrice:800}),/تغيرت الفاتورة/);assert.deepEqual(await f.snapshot(),unchanged);
 await assert.rejects(f.run({type:'decant-sale.void',documentId:id,expectedRevision:0}),/تغيرت الفاتورة/);assert.deepEqual(await f.snapshot(),unchanged);
 await f.run({type:'decant-sale.void',documentId:id});const restored=await f.product();assert.deepEqual(restored.stocks,initial.stocks);assert.deepEqual(restored.perfumeLots,initial.perfumeLots);
 assert.equal((await f.db.collection('parties').findOne({id:customer})).receivable,0);assert.equal((await f.report('sales')).summary.netSales,0);
 const finance=await f.db.collection('financialMovements').find({documentId:id}).toArray();assert.equal(finance.length,2);assert.equal(finance[0].status,'reversed');assert.equal(finance[1].isReversal,true);
 const done=await f.snapshot();await assert.rejects(f.run({type:'decant-sale.void',documentId:id}));assert.deepEqual(await f.snapshot(),done);
});

test('remainder quantity/lot edit changes only its own sale and rejects invalid replacements atomically',async t=>{
 const f=await fixture(t),id=await f.sale({note:'Original note'}),before=await f.snapshot();
 for(const extra of [{quantityMl:101},{lotId:'missing'},{productId:'full'},{warehouseId:'missing'},{paymentMethod:'missing'},{partyId:'missing'},{paymentMethod:'note'},{cashAmount:5},{note:'x'.repeat(2001)}]){
  await assert.rejects(f.update(id,extra));assert.deepEqual(await f.snapshot(),before);
 }
 await f.update(id,{quantityMl:40,totalPrice:900,note:''});const doc=await f.doc(id);assert.equal(doc.note,null);assert.equal(doc.lines[0].costAtSale,400);assert.equal(doc.lines[0].grossProfit,500);assert.equal((await f.product()).stocks.w,60);
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10900);assert.equal((await f.report('financial')).summary.incoming,900);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product()).stocks.w,100);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
});

test('remainder input validates ml precision, amount, references and normal invoice settlement without mutations',async t=>{
 const f=await fixture(t),supplier=await f.run({type:'party.create',partyType:'supplier',name:'Synthetic supplier'}),before=await f.snapshot();
 for(const extra of [{quantityMl:0},{quantityMl:-1},{quantityMl:0.0001},{quantityMl:Infinity},{quantityMl:true},{totalPrice:0},{totalPrice:NaN},{totalPrice:true},{totalPrice:' '},{totalPrice:Number.MAX_VALUE},{lotId:'missing'},{productId:'full'},{partyId:123},{partyId:supplier},{partyId:'missing'},{paymentMethod:'note'},{cashAmount:100},{warehouseId:'missing'}]){
  await assert.rejects(f.sale(extra));assert.deepEqual(await f.snapshot(),before);
 }
 const p=await f.product();await f.db.collection('products').updateOne({id:p.id},{$set:{'stocks.w':99}});const inconsistent=await f.snapshot();await assert.rejects(f.sale(),/لا يطابق/);assert.deepEqual(await f.snapshot(),inconsistent);
});

test('remainder route cannot replace an ordinary bottled sale or be created through its normal invoice editor',async t=>{
 const f=await fixture(t),id=await f.sale(),before=await f.snapshot();
 await assert.rejects(f.run({type:'decant-sale.update',documentId:id,expectedRevision:0,paymentMethod:'cash',lines:[{productId:f.productId,quantity:1,unitPrice:500}]}),/بيع المتبقي/);
 await assert.rejects(f.run({type:'decant-sale.post',perfumeSaleMode:'remainder',...f.input,lines:[{productId:f.productId,quantity:1,unitPrice:500}]}),/بيع المتبقي/);assert.deepEqual(await f.snapshot(),before);
 await f.db.collection('products').insertOne({id:'glass',sku:'3',name:'Synthetic bottle',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:2},pieceCost:20,openingCost:20,lastPurchaseCost:20});
 const regular=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:f.productId,quantity:1,bottleProductId:'glass',unitPrice:200}]}),current=await f.snapshot();
 await assert.rejects(f.update(regular),/عادية/);assert.deepEqual(await f.snapshot(),current);
});

test('later absolute lot counts block remainder edit/void with actual source document, and work after count cancellation',async t=>{
 const f=await fixture(t),id=await f.sale(),count=await f.run({type:'perfume-lot-correct.post',decantProductId:f.productId,lotId:f.lotId,warehouseId:'w',actualQuantity:70,reason:'Synthetic count'}),before=await f.snapshot();
 for(const action of [()=>f.run({type:'decant-sale.void',documentId:id}),()=>f.update(id,{totalPrice:700})]){
  await assert.rejects(action(),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===count));assert.deepEqual(await f.snapshot(),before);
 }
 await f.run({type:'perfume-management.void',documentId:count});await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product()).stocks.w,100);
});

test('fully sold remainder cannot reopen over a newer positive lot, but succeeds after the newer conversion is canceled',async t=>{
 const f=await fixture(t),id=await f.sale({quantityMl:100}),second=await f.split(),before=await f.snapshot();
 await assert.rejects(f.run({type:'decant-sale.void',documentId:id}),error=>error.code==='PERFUME_OPERATION_BLOCKED'&&error.dependencies.some(d=>d.documentId===second));assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'perfume-management.void',documentId:second});await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product()).stocks.w,100);
});

test('legacy piece lots require explicit supported ml migration and historical return documents/products stay unchanged',async t=>{
 const f=await fixture(t),returned=await f.run({type:'perfume-recombine.post',decantProductId:f.productId,lotId:f.lotId,warehouseId:'w',actualQuantity:100,salePrice:900,reason:'Synthetic historical return'});
 const oldDoc=await f.doc(returned),partial=await f.db.collection('products').findOne({id:oldDoc.partialProductId}),before=await f.snapshot();
 await assert.rejects(f.sale(),/مغلقة|أُرجع/);assert.deepEqual(await f.doc(returned),oldDoc);assert.deepEqual(await f.db.collection('products').findOne({id:partial.id}),partial);assert.deepEqual(await f.snapshot(),before);
 await f.run({type:'perfume-management.void',documentId:returned});
 const p=await f.product(),lots=structuredClone(p.perfumeLots);delete lots[0].quantityUnit;
 await f.db.collection('products').updateOne({id:p.id},{$set:{perfumeStockUnit:'piece',perfumeLots:lots}});const legacy=await f.snapshot();
 await assert.rejects(f.sale(),/حوّل رصيدها إلى المل/);assert.deepEqual(await f.snapshot(),legacy);
});

test('remainder native backup round trip preserves mode, ml allocation and cancellable invoice history',async t=>{
 const f=await fixture(t),id=await f.sale(),backup=parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
 await f.db.transaction(session=>restoreNativeBackup(f.db,backup,session));const doc=await f.doc(id);assert.equal(doc.perfumeSaleMode,'remainder');assert.equal(doc.lines[0].perfumeAllocations[0].quantityUnit,'ml');
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product()).stocks.w,100);
});

test('actual POST preserves permissions, failed-receipt rollback, same-key retry and successful idempotency',async t=>{
 const f=await fixture(t);await f.db.collection('users').insertMany([{id:'manager',username:'manager',name:'Synthetic manager',isActive:true,permissions:['perfume.divisions.manage']},{id:'viewer',username:'viewer',name:'Synthetic viewer',isActive:true,permissions:['products.view']}]);
 const origin='http://127.0.0.1:3219',post=async(body,key,user='manager')=>{const token=createSession({principalType:'user',userId:user});const response=await POST(new Request(origin+'/api/command',{method:'POST',headers:{origin,host:'127.0.0.1:3219',cookie:'conta_session='+token,'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()}};
 const body={type:'perfume-remainder-sale.post',...f.input},before=await f.snapshot(),denied=await post(body,'denied','viewer');assert.equal(denied.status,403);assert.deepEqual(await f.snapshot(),before);
 f.db.native.exec("CREATE TRIGGER remainder_finance_failure BEFORE INSERT ON financial_movements BEGIN SELECT RAISE(ABORT,'PRIVATE_REMAINDER_SQL'); END");
 const failure=await post(body,'sale');assert.equal(failure.status,500);assert.deepEqual(failure.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'sale'}),null);
 f.db.native.exec('DROP TRIGGER remainder_finance_failure');
 const first=await post(body,'sale');assert.equal(first.status,200,JSON.stringify(first));const committed=await f.snapshot();assert.deepEqual(await post(body,'sale'),first);assert.deepEqual(await f.snapshot(),committed);
 const updateBody={type:'perfume-remainder-sale.update',documentId:first.body.id,expectedRevision:0,...f.input,totalPrice:650};
 const updated=await post(updateBody,'update');assert.equal(updated.status,200);assert.equal(updated.body.id,first.body.id);const updatedSnapshot=await f.snapshot();assert.deepEqual(await post(updateBody,'update'),updated);assert.deepEqual(await f.snapshot(),updatedSnapshot);assert.equal((await f.doc(first.body.id)).total,650);
 const count=await f.run({type:'perfume-lot-correct.post',decantProductId:f.productId,lotId:f.lotId,warehouseId:'w',actualQuantity:70,reason:'Synthetic count'}),blockedBefore=await f.snapshot(),voidBody={type:'decant-sale.void',documentId:first.body.id};
 const blocked=await post(voidBody,'void-retry');assert.equal(blocked.status,409);assert.equal(blocked.body.code,'PERFUME_OPERATION_BLOCKED');assert(blocked.body.dependencies.some(d=>d.documentId===count));assert.deepEqual(await f.snapshot(),blockedBefore);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'void-retry'}),null);
 await f.run({type:'perfume-management.void',documentId:count});const retry=await post(voidBody,'void-retry');assert.equal(retry.status,200);const completed=await f.snapshot();assert.deepEqual(await post(voidBody,'void-retry'),retry);assert.deepEqual(await f.snapshot(),completed);assert.equal((await f.product()).stocks.w,100);
});
