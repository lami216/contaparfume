import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,parseAndValidateBackup} from '../lib/backup.ts';
import {currentProductCost} from '../lib/product-cost.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertMany([{_id:'w',name:'Audit',isSalesDefault:true},{_id:'other',name:'Other',isSalesDefault:false}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([{id:'full',sku:'1',name:'Source',perfumeForm:'full',stocks:{w:1},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500},{id:'bottle',sku:'2',name:'Bottle 10ml',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:10},openingCost:20,lastPurchaseCost:20,pieceCost:20}]);
 const run=b=>db.transaction(s=>execute(db,s,b));
 await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 const liquid=await db.collection('products').findOne({perfumeForm:'decant'}),p=liquid.id;
 const sale=(extra={})=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:p,quantity:1,fillMl:10,bottleProductId:'bottle',unitPrice:200}],...extra});
 const purchase=(price=50,extra={})=>run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:'bottle',quantity:10,unitPrice:price}],...extra});
 const product=id=>db.collection('products').findOne({id}),doc=id=>db.collection('documents').findOne({id});
 const report=type=>buildReport(db,parseReportFilters(new URL(`http://local/api/reports?type=${type}&allTime=true`)));
 const snapshot=()=>Promise.all(['products','warehouses','parties','paymentAccounts','documents','stockMovements','financialMovements','counters'].map(n=>db.collection(n).find().toArray()));
 const update=(id,extra={})=>run({type:'decant-sale.update',documentId:id,expectedRevision:0,paymentMethod:'cash',lines:[{productId:p,quantity:1,fillMl:10,bottleProductId:'bottle',unitPrice:200}],...extra});
 return{db,run,p,sale,purchase,product,doc,report,snapshot,update};
}

test('A03: a customer/payment-only decant edit retains its historical liquid and bottle cost',async t=>{
 const f=await fixture(t),id=await f.sale(),before=await f.doc(id);
 assert.equal(before.lines[0].costAtSale,120);assert.equal(before.lines[0].grossProfit,80);
 await f.purchase(50);const customer=await f.run({type:'party.create',partyType:'customer',name:'Customer'});
 await f.update(id,{partyId:customer});const after=await f.doc(id);
 assert.equal(after.lines[0].bottleUnitCost,20);assert.equal(after.lines[0].costAtSale,120);assert.equal(after.lines[0].grossProfit,80);
 assert.deepEqual(after.lines[0].perfumeAllocations,before.lines[0].perfumeAllocations);
 assert.equal((await f.report('sales')).summary.profit,80);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);
});

test('A03: an unchanged empty-bottle line keeps cost after a later purchase and a price edit',async t=>{
 const f=await fixture(t),lines=[{productId:'bottle',quantity:2,unitPrice:100}],id=await f.sale({lines});
 await f.purchase(50);await f.update(id,{lines:[{...lines[0],unitPrice:110}]});
 const after=await f.doc(id);assert.equal(after.lines[0].costAtSale,20);assert.equal(after.lines[0].grossProfit,180);
});

test('A04: editing an older bottle purchase does not replace the latest purchase cache',async t=>{
 const f=await fixture(t),first=await f.purchase(20),second=await f.purchase(50);
 await f.db.collection('documents').updateOne({id:first},{$set:{occurredAt:'2026-10-20T12:00:00.000Z'}});
 await f.db.collection('documents').updateOne({id:second},{$set:{occurredAt:'2026-10-22T12:00:00.000Z'}});
 await f.run({type:'decant-purchase.update',documentId:first,expectedRevision:0,paymentMethod:'cash',lines:[{productId:'bottle',quantity:10,unitPrice:25}]});
 let bottle=await f.product('bottle');assert.equal(bottle.lastPurchaseCost,50);assert.equal(bottle.lastPurchaseAt,'2026-10-22T12:00:00.000Z');
 assert.equal(await f.db.transaction(s=>currentProductCost(f.db,s,bottle)),50);
 await f.run({type:'decant-purchase.void',documentId:second});assert.equal((await f.product('bottle')).lastPurchaseCost,25);
});

test('A05: sale void retains linked financial evidence without reporting reversal as new income',async t=>{
 const f=await fixture(t),id=await f.sale(),original=await f.db.collection('financialMovements').findOne({documentId:id});
 await f.run({type:'decant-sale.void',documentId:id});
 const rows=await f.db.collection('financialMovements').find({documentId:id}).toArray();assert.equal(rows.length,2);
 const reversed=rows.find(x=>x.id===original.id),reversal=rows.find(x=>x.isReversal===true);
 assert.equal(reversed.status,'reversed');assert.equal(reversed.reversalMovementId,reversal.id);assert.equal(reversal.reversalOfMovementId,original.id);assert.equal(reversal.direction,'out');
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
 assert.equal((await f.report('financial')).summary.incoming,0);assert.equal((await f.report('financial')).summary.outgoing,0);
 const before=await f.snapshot();await assert.rejects(f.run({type:'decant-sale.void',documentId:id}));assert.deepEqual(await f.snapshot(),before);
});

test('A05: purchase edit and void retain each payment revision and only one effective cost/report amount',async t=>{
 const f=await fixture(t),id=await f.purchase(20);
 await f.run({type:'decant-purchase.update',documentId:id,expectedRevision:0,paymentMethod:'cash',lines:[{productId:'bottle',quantity:10,unitPrice:25}]});
 let rows=await f.db.collection('financialMovements').find({documentId:id}).toArray();
 assert.equal(rows.length,3);assert.equal(rows.filter(x=>x.status!=='reversed'&&!x.isReversal).length,1);
 assert.equal((await f.report('financial')).summary.outgoing,250);assert.equal((await f.report('purchases')).summary.total,250);
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,9750);
 await f.run({type:'decant-purchase.void',documentId:id});rows=await f.db.collection('financialMovements').find({documentId:id}).toArray();
 assert.equal(rows.length,4);assert.equal(rows.filter(x=>x.status!=='reversed'&&!x.isReversal).length,0);
 assert.equal((await f.report('financial')).summary.outgoing,0);assert.equal((await f.report('purchases')).summary.total,0);
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10000);
 parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
});

test('A06: voiding a settled note invoice reopens its actually archived customer with the returned credit',async t=>{
 const f=await fixture(t),partyId=await f.run({type:'party.create',partyType:'customer',name:'Archived customer'});
 const id=await f.sale({paymentMethod:'note',partyId});
 await f.run({type:'party-cash.post',partyId,direction:'receive',paymentMethod:'cash',amount:200});
 assert.equal((await f.run({type:'party.delete',id:partyId})).disposition,'archived');
 await f.run({type:'decant-sale.void',documentId:id});const party=await f.db.collection('parties').findOne({id:partyId});
 assert.equal(party.payable,200);assert.equal(party.receivable,0);assert.equal(party.isArchived,false);
});

test('A06: sale reversal reopens a genuinely archived empty warehouse and bottle',async t=>{
 const f=await fixture(t),id=await f.sale({lines:[{productId:f.p,quantity:10,fillMl:10,bottleProductId:'bottle',unitPrice:200}]});
 await f.run({type:'warehouse.default',warehouseId:'other'});await f.run({type:'warehouse.delete',id:'w'});
 assert.equal((await f.db.collection('warehouses').findOne({_id:'w'})).isArchived,true);
 await f.run({type:'perfume-bottle.archive',id:'bottle'});assert.equal((await f.product('bottle')).isArchived,true);
 await f.run({type:'decant-sale.void',documentId:id});
 assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('bottle')).stocks.w,10);
 assert.equal((await f.db.collection('warehouses').findOne({_id:'w'})).isArchived,false);assert.equal((await f.product('bottle')).isArchived,false);
});

test('A06: purchase reversal reactivates an actually archived zero-balance payment account',async t=>{
 const f=await fixture(t),account=await f.run({type:'payment-account.create',name:'Audit bank',openingBalance:200});
 const id=await f.purchase(20,{paymentMethod:account});assert.equal((await f.run({type:'payment-account.delete',accountId:account})).disposition,'archived');
 await f.run({type:'decant-purchase.void',documentId:id});const bank=await f.db.collection('paymentAccounts').findOne({id:account});
 assert.equal(bank.balance,200);assert.equal(bank.isActive,true);assert.equal(bank.isArchived,false);
});

test('A09: paid sale/purchase reject explicit missing, wrong-type and archived parties atomically',async t=>{
 const f=await fixture(t),customer=await f.run({type:'party.create',partyType:'customer',name:'Customer'}),supplier=await f.run({type:'party.create',partyType:'supplier',name:'Supplier'});
 for(const [post,partyId] of [[f.sale,'missing'],[()=>f.purchase(20,{partyId:'missing'}),'missing'],[f.sale,supplier],[()=>f.purchase(20,{partyId:customer}),customer]]){
  const before=await f.snapshot();await assert.rejects(post({partyId}),/عميل|مورد|طرف/);assert.deepEqual(await f.snapshot(),before);
 }
 for(const partyId of [123,false,{}]){const before=await f.snapshot();await assert.rejects(f.sale({partyId}),/عميل/);await assert.rejects(f.purchase(20,{partyId}),/مورد/);assert.deepEqual(await f.snapshot(),before);}
 await f.sale({partyId:customer});await f.run({type:'party.delete',id:customer});
 const before=await f.snapshot();await assert.rejects(f.sale({partyId:customer}),/عميل|طرف/);assert.deepEqual(await f.snapshot(),before);
 parseAndValidateBackup(JSON.stringify(await createNativeBackup(f.db)));
});

test('invoice replacement failure rolls back original finance, stocks, lots and revision after audit history is kept',async t=>{
 const f=await fixture(t),id=await f.sale(),before=await f.snapshot();
 await assert.rejects(f.update(id,{lines:[{productId:f.p,quantity:100,fillMl:10,bottleProductId:'bottle',unitPrice:200}]}),/غير كاف/);
 assert.deepEqual(await f.snapshot(),before);
 await f.update(id);const rows=await f.db.collection('financialMovements').find({documentId:id}).toArray();
 assert.equal(rows.filter(x=>x.status!=='reversed'&&!x.isReversal).length,1);assert.equal(rows.length,3);
 const snapshot=await f.snapshot();await assert.rejects(f.update(id),/تغيرت الفاتورة/);assert.deepEqual(await f.snapshot(),snapshot);
});
