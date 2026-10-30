import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute,POST as postCommand} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertMany([{_id:'w',name:'Audit',isSalesDefault:true},{_id:'other',name:'Other'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('products').insertMany([{id:'full',sku:'1',name:'Source',perfumeForm:'full',stocks:{w:1},openingCost:1000,lastPurchaseCost:1000,piecePrice:1500},{id:'bottle',sku:'2',name:'Bottle',perfumeForm:'bottle',decantSizeMl:10,stocks:{w:10},openingCost:20,lastPurchaseCost:20,pieceCost:20}]);
 const run=body=>db.transaction(s=>execute(db,s,body));
 await run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 const liquid=await db.collection('products').findOne({perfumeForm:'decant'}),p=liquid.id;
 const line={productId:p,quantity:1,fillMl:10,bottleProductId:'bottle',unitPrice:200};
 const sale=extra=>run({type:'decant-sale.post',paymentMethod:'cash',lines:[line],...extra});
 const purchase=()=>run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:'bottle',quantity:10,unitPrice:50}]});
 const doc=id=>db.collection('documents').findOne({id}),product=id=>db.collection('products').findOne({id});
 const edit=async(id,extra={})=>{const d=await doc(id);return run({type:'decant-sale.update',documentId:id,expectedRevision:d.revision??0,paymentMethod:d.paymentMethod,partyId:d.partyId,lines:d.lines.map(l=>({productId:l.productId,quantity:l.quantity,unitPrice:l.unitPrice,fillMl:l.fillMl,bottleProductId:l.bottleProductId})),...extra})};
 const report=type=>buildReport(db,parseReportFilters(new URL(`http://local/api/reports?type=${type}&allTime=true`)));
 const snapshot=()=>Promise.all(['products','warehouses','parties','paymentAccounts','documents','stockMovements','financialMovements','counters','commandReceipts'].map(name=>db.collection(name).find().toArray()));
 const http=(body,key)=>postCommand(new Request('http://localhost/api/command',{method:'POST',headers:{Host:'localhost',Origin:'http://localhost','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));
 const balance=async()=>Number((await db.collection('paymentAccounts').findOne({id:'cash'})).balance);
 return{db,run,p,line,sale,purchase,doc,product,edit,report,snapshot,http,balance};
}

test('adversarial invoices: repeated price edits and spoofed snapshots retain server historical allocations and costs',async t=>{
 const f=await fixture(t),id=await f.sale({lines:[{...f.line,costAtSale:0,bottleUnitCost:0,perfumeAllocations:[{lotId:'forged',quantity:9999,unitCost:0}]}]}),original=await f.doc(id);
 assert.equal(original.lines[0].costAtSale,120);await f.purchase();
 for(const unitPrice of [210,240,220]){
  await f.edit(id,{lines:[{...f.line,unitPrice,costAtSale:0,bottleUnitCost:0,perfumeAllocations:[{lotId:'forged',quantity:9999,unitCost:0}]}],historical:{lines:[{costAtSale:0}]},existing:{lines:[{costAtSale:0}]}});
  const d=await f.doc(id);assert.equal(d.lines[0].bottleUnitCost,20);assert.equal(d.lines[0].costAtSale,120);assert.equal(d.lines[0].grossProfit,unitPrice-120);assert.deepEqual(d.lines[0].perfumeAllocations,original.lines[0].perfumeAllocations);
  assert.equal((await f.product(f.p)).stocks.w,90);assert.equal((await f.product('bottle')).stocks.w,19);
 }
 const d=await f.doc(id);assert.equal(d.revision,3);assert.equal(d.editHistory.length,3);assert.equal(await f.balance(),9720);
 const movements=await f.db.collection('financialMovements').find({documentId:id}).toArray();assert.equal(movements.length,7);assert.equal(movements.filter(m=>m.status!=='reversed'&&!m.isReversal).length,1);
});

test('adversarial invoices: changed quantity uses current approved cost while unchanged later edits retain the revised snapshot',async t=>{
 const f=await fixture(t),id=await f.sale();await f.purchase();
 await f.edit(id,{lines:[{...f.line,quantity:2,bottleUnitCost:1,costAtSale:1}]});
 let d=await f.doc(id);assert.equal(d.lines[0].bottleUnitCost,50);assert.equal(d.lines[0].costAtSale,150);assert.equal(d.lines[0].grossProfit,100);assert.equal((await f.product(f.p)).stocks.w,80);
 await f.edit(id,{lines:[{...f.line,quantity:2,unitPrice:210}]});d=await f.doc(id);assert.equal(d.lines[0].costAtSale,150);assert.equal(d.lines[0].grossProfit,120);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.product(f.p)).stocks.w,100);assert.equal((await f.product('bottle')).stocks.w,20);
});

test('adversarial invoices: paid-credit-customer changes preserve independent receipts, credits and financial audit',async t=>{
 const f=await fixture(t),a=await f.run({type:'party.create',partyType:'customer',name:'A'}),b=await f.run({type:'party.create',partyType:'customer',name:'B'}),id=await f.sale({partyId:a});
 await f.edit(id,{paymentMethod:'note',partyId:a});assert.equal(await f.balance(),10000);assert.equal((await f.db.collection('parties').findOne({id:a})).receivable,200);
 const receipt=await f.run({type:'party-cash.post',partyId:a,direction:'receive',paymentMethod:'cash',amount:200});await f.run({type:'party.delete',id:a});
 await f.edit(id,{paymentMethod:'cash',partyId:a});const credited=await f.db.collection('parties').findOne({id:a});assert.equal(credited.payable,200);assert.equal(credited.isArchived,false);assert.equal(await f.balance(),10400);
 await f.edit(id,{paymentMethod:'note',partyId:b});assert.equal(await f.balance(),10200);assert.equal((await f.db.collection('parties').findOne({id:a})).payable,200);assert.equal((await f.db.collection('parties').findOne({id:b})).receivable,200);
 assert.equal((await f.doc(id)).lines[0].costAtSale,120);const financial=await f.report('financial');assert.equal(financial.summary.incoming,200);assert.equal(financial.summary.outgoing,0);
 await f.run({type:'decant-sale.void',documentId:id});assert.equal((await f.db.collection('parties').findOne({id:b})).receivable,0);
 await f.run({type:'party-cash.void',documentId:receipt});assert.equal(await f.balance(),10000);assert.equal((await f.db.collection('parties').findOne({id:a})).payable,0);
});

test('adversarial invoices: failed replacement after stock restoration rolls back every accounting and revision write',async t=>{
 const f=await fixture(t),id=await f.sale(),before=await f.snapshot();
 await assert.rejects(f.edit(id,{cashAmount:0}),/الدفع الجزئي/);assert.deepEqual(await f.snapshot(),before);
 await assert.rejects(f.edit(id,{partyId:'missing'}),/عميل|طرف/);assert.deepEqual(await f.snapshot(),before);
 await assert.rejects(f.edit(id,{lines:[{...f.line,fillMl:11}]}),/التعبئة/);assert.deepEqual(await f.snapshot(),before);
 await f.edit(id);const after=await f.snapshot();await assert.rejects(f.run({type:'decant-sale.update',documentId:id,expectedRevision:0,paymentMethod:'cash',lines:[f.line]}),/تغيرت الفاتورة/);assert.deepEqual(await f.snapshot(),after);
});

test('adversarial invoices: HTTP idempotency repeats one committed edit without a second stock or cash effect',async t=>{
 const f=await fixture(t),id=await f.sale(),body={type:'decant-sale.update',documentId:id,expectedRevision:0,paymentMethod:'cash',lines:[{...f.line,unitPrice:230}]};
 const first=await f.http(body,'audit-invoice-edit-once');assert.equal(first.status,200);const firstReply=await first.json(),after=await f.snapshot();
 const repeated=await f.http(body,'audit-invoice-edit-once');assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),firstReply);assert.deepEqual(await f.snapshot(),after);
 const different=await f.http({...body,lines:[{...f.line,unitPrice:240}]},'audit-invoice-edit-once');assert.equal(different.status,409);assert.deepEqual(await f.snapshot(),after);
 assert.equal((await f.doc(id)).revision,1);assert.equal(await f.balance(),10230);assert.equal((await f.product(f.p)).stocks.w,90);
});

test('adversarial invoices: net-neutral historical edits preserve originally archived zero-balance entities',async t=>{
 const f=await fixture(t),partyId=await f.run({type:'party.create',partyType:'customer',name:'Settled historic customer'}),id=await f.sale({paymentMethod:'note',partyId,lines:[{...f.line,quantity:10}]});
 await f.run({type:'party-cash.post',partyId,direction:'receive',paymentMethod:'cash',amount:2000});await f.run({type:'party.delete',id:partyId});
 await f.run({type:'warehouse.default',warehouseId:'other'});await f.run({type:'warehouse.delete',id:'w'});await f.run({type:'perfume-bottle.archive',id:'bottle'});
 assert.equal((await f.db.collection('parties').findOne({id:partyId})).isArchived,true);assert.equal((await f.db.collection('warehouses').findOne({_id:'w'})).isArchived,true);assert.equal((await f.product('bottle')).isArchived,true);
 const archivedAt={party:(await f.db.collection('parties').findOne({id:partyId})).archivedAt,warehouse:(await f.db.collection('warehouses').findOne({_id:'w'})).archivedAt,bottle:(await f.product('bottle')).archivedAt};
 await f.edit(id);
 const party=await f.db.collection('parties').findOne({id:partyId}),warehouse=await f.db.collection('warehouses').findOne({_id:'w'}),bottle=await f.product('bottle');
 assert.equal(party.receivable,0);assert.equal(party.payable,0);assert.equal(bottle.stocks.w,0);assert.equal((await f.product(f.p)).stocks.w,0);
 assert.deepEqual({party:party.isArchived,warehouse:warehouse.isArchived,bottle:bottle.isArchived},{party:true,warehouse:true,bottle:true},'temporary rollback/repost is not an explicit restore request for neutral historical entities');
 assert.deepEqual({party:party.archivedAt,warehouse:warehouse.archivedAt,bottle:bottle.archivedAt},archivedAt);
});

test('adversarial invoices: genuine returned credit or stock remains visible after editing an archived historical invoice',async t=>{
 const f=await fixture(t),partyId=await f.run({type:'party.create',partyType:'customer',name:'Settled stock customer'}),id=await f.sale({paymentMethod:'note',partyId,lines:[{...f.line,quantity:10}]});
 await f.run({type:'party-cash.post',partyId,direction:'receive',paymentMethod:'cash',amount:2000});await f.run({type:'party.delete',id:partyId});
 await f.run({type:'warehouse.default',warehouseId:'other'});await f.run({type:'warehouse.delete',id:'w'});await f.run({type:'perfume-bottle.archive',id:'bottle'});
 await f.edit(id,{lines:[{...f.line,quantity:9}]});
 const party=await f.db.collection('parties').findOne({id:partyId}),warehouse=await f.db.collection('warehouses').findOne({_id:'w'}),bottle=await f.product('bottle');
 assert.equal(party.payable,200);assert.equal(party.isArchived,false);assert.equal(warehouse.isArchived,false);assert.equal(bottle.isArchived,false);assert.equal(bottle.stocks.w,1);assert.equal((await f.product(f.p)).stocks.w,10);
});

test('adversarial invoices: a neutral archived account stays archived, but a genuine balance change reactivates it',async t=>{
 const f=await fixture(t),account=await f.run({type:'payment-account.create',name:'Historic audit bank',openingBalance:0}),id=await f.sale({paymentMethod:account});
 await f.run({type:'account-adjustment.post',accountId:account,direction:'withdrawal',amount:200,note:'Independent old withdrawal'});await f.run({type:'payment-account.delete',accountId:account});
 const original=await f.db.collection('paymentAccounts').findOne({id:account});assert.equal(original.isArchived,true);
 await f.edit(id);let bank=await f.db.collection('paymentAccounts').findOne({id:account});assert.equal(bank.balance,0);assert.equal(bank.isArchived,true);assert.equal(bank.isActive,false);assert.equal(bank.archivedAt,original.archivedAt);
 await f.edit(id,{lines:[{...f.line,unitPrice:210}]});bank=await f.db.collection('paymentAccounts').findOne({id:account});assert.equal(bank.balance,10);assert.equal(bank.isArchived,false);assert.equal(bank.isActive,true);
});
