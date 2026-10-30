import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {deriveOpeningStockState} from '../lib/opening-stock.ts';

async function fixture(t,{bottle=false}={}){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertMany(['a','b','c','d'].map((_id,i)=>({_id,name:_id.toUpperCase(),isSalesDefault:i===0})));
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Audit cash',isActive:true,balance:1000000,openingBalance:1000000});
 const run=body=>db.transaction(s=>execute(db,s,body));
 const id=bottle?await run({type:'perfume-bottle.create',name:'Audit bottle',sizeMl:10,cost:20}):await run({type:'product.create',name:'Audit product',pieceCost:50,piecePrice:100,openingStock:10,openingWarehouseId:'a'});
 if(bottle)await run({type:'product.update',id,name:'Audit bottle',pieceCost:20,piecePrice:100,replaceOpeningStock:true,openingStock:10,openingCost:20,openingWarehouseId:'a'});
 const product=()=>db.collection('products').findOne({id});
 const state=async()=>deriveOpeningStockState(db,undefined,await product());
 const purchase=(quantity,warehouseId='a')=>run({type:bottle?'decant-purchase.post':'purchase.post',warehouseId,paymentMethod:'cash',lines:[{productId:id,quantity,unitPrice:50}]});
 const sale=(quantity,warehouseId='a')=>run({type:bottle?'decant-sale.post':'sale.post',warehouseId,paymentMethod:'cash',lines:[{productId:id,quantity,...(bottle?{unitPrice:100}:{piecePrice:100})}]});
 const voidSale=documentId=>run({type:bottle?'decant-sale.void':'sale.void',documentId});
 const voidPurchase=documentId=>run({type:bottle?'decant-purchase.void':'purchase.void',documentId});
 const count=actualQuantity=>bottle?run({type:'perfume-bottle-stock.post',bottleProductId:id,warehouseId:'a',actualQuantity,bottleStockReason:'correction',reason:'Audit physical count'}):run({type:'adjustment.post',warehouseId:'a',reason:'Audit physical count',lines:[{productId:id,actualQuantity}]});
 const voidCount=documentId=>run({type:bottle?'perfume-management.void':'adjustment.void',documentId});
 const transfer=(fromWarehouseId,toWarehouseId,quantity)=>run({type:'transfer.post',fromWarehouseId,toWarehouseId,lines:[{productId:id,quantity}]});
 const opening=()=>db.collection('documents').findOne({title:'رصيد بداية','lines.productId':id});
 const assertOpening=async(expected,consumed=10-Object.values(expected).reduce((s,q)=>s+q,0))=>{
  const s=await state(),p=await product();assert.equal(s.total,10);assert.equal(s.consumed,consumed);assert.equal(s.remaining,Object.values(expected).reduce((v,q)=>v+q,0));assert.deepEqual(s.allocations,expected);
  for(const[wh,quantity]of Object.entries(s.allocations))assert.ok(quantity<=Number(p.stocks?.[wh]??0)+1e-9,`opening allocation ${wh}=${quantity} exceeds actual stock ${p.stocks?.[wh]}`);
 };
 return{db,run,id,product,state,purchase,sale,voidSale,voidPurchase,count,voidCount,transfer,opening,assertOpening};
}

test('adversarial provenance: partial mixed-origin sale edits restore the original chunks in reverse order',async t=>{
 const f=await fixture(t),purchase=await f.purchase(5),sale=await f.sale(12);
 await f.assertOpening({},10);
 const edit=quantity=>f.run({type:'sale.update',documentId:sale,paymentMethod:'cash',lines:[{productId:f.id,quantity,piecePrice:100}]});
 await edit(8);await f.assertOpening({a:2},8);
 await edit(11);await f.assertOpening({},10);
 await edit(4);await f.assertOpening({a:6},4);
 await f.voidSale(sale);await f.assertOpening({a:10},0);
 await f.voidPurchase(purchase);await f.assertOpening({a:10},0);
 assert.equal((await f.product()).stocks.a,10);
});

test('adversarial provenance: an unrelated positive count cannot replace a sold opening entitlement',async t=>{
 const f=await fixture(t),sale=await f.sale(4),count=await f.count(10);
 assert.equal((await f.product()).stocks.a,10);await f.assertOpening({a:6},4);
 await assert.rejects(f.run({type:'opening-stock-initial.void',documentId:(await f.opening()).id}),/تم التصرف|لا يمكن خفض/);
 await f.voidSale(sale);await f.assertOpening({a:10},0);
 await f.voidCount(count);await f.assertOpening({a:10},0);
});

test('adversarial provenance: full inverse cycles restore opening sources after a purchase reversal used substitute stock',async t=>{
 const f=await fixture(t),purchase=await f.purchase(5),sale=await f.sale(12),count=await f.count(1);
 await f.voidSale(sale);
 await f.voidPurchase(purchase);
 assert.equal((await f.product()).stocks.a,8);await f.assertOpening({a:8},2);
 await f.voidCount(count);
 assert.equal((await f.product()).stocks.a,10);await f.assertOpening({a:10},0);
 await f.run({type:'opening-stock-initial.void',documentId:(await f.opening()).id});
 assert.equal((await f.product()).stocks.a,0);
});

test('adversarial provenance: reducing a purchase after source consumption does not permanently consume substituted opening units',async t=>{
 const f=await fixture(t),purchase=await f.purchase(5),sale=await f.sale(12),count=await f.count(1);
 await f.voidSale(sale);
 await f.run({type:'purchase.update',documentId:purchase,warehouseId:'a',paymentMethod:'cash',lines:[{productId:f.id,quantity:1,unitPrice:50}]});
 assert.equal((await f.product()).stocks.a,9);await f.assertOpening({a:9},1);
 await f.voidCount(count);assert.equal((await f.product()).stocks.a,11);await f.assertOpening({a:10},0);
 await f.voidPurchase(purchase);assert.equal((await f.product()).stocks.a,10);await f.assertOpening({a:10},0);
});

test('adversarial provenance: partial purchase reduction before sale cancellation remains reversible with later replacement purchases',async t=>{
 const f=await fixture(t),first=await f.purchase(5),sale=await f.sale(12),later=await f.purchase(5);
 await f.run({type:'purchase.update',documentId:first,warehouseId:'a',paymentMethod:'cash',lines:[{productId:f.id,quantity:1,unitPrice:50}]});
 assert.equal((await f.product()).stocks.a,4);await f.assertOpening({},10);
 await f.voidSale(sale);assert.equal((await f.product()).stocks.a,16);await f.assertOpening({a:10},0);
 await f.voidPurchase(later);assert.equal((await f.product()).stocks.a,11);await f.assertOpening({a:10},0);
 await f.voidPurchase(first);assert.equal((await f.product()).stocks.a,10);await f.assertOpening({a:10},0);
 assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,1000000);
});

test('adversarial provenance: editing a transfer source with the same destination restores the old origin before applying the new origin',async t=>{
 const f=await fixture(t);await f.purchase(5,'c');const transfer=await f.transfer('a','b',8);
 await f.assertOpening({a:2,b:8},0);
 await f.run({type:'transfer.update',documentId:transfer,fromWarehouseId:'c',toWarehouseId:'b',lines:[{productId:f.id,quantity:3}]});
 assert.deepEqual((await f.product()).stocks,{a:10,c:2,b:3});await f.assertOpening({a:10},0);
 await f.run({type:'transfer.void',documentId:transfer});await f.assertOpening({a:10},0);
 assert.deepEqual((await f.product()).stocks,{a:10,c:5,b:0});
});

test('adversarial provenance: legacy transfers without revision fields never look ahead across sale and edit events',async t=>{
 const f=await fixture(t),transfer=await f.transfer('a','b',6),sale=await f.sale(2,'b');
 await f.voidSale(sale);
 await f.run({type:'transfer.update',documentId:transfer,fromWarehouseId:'a',toWarehouseId:'b',lines:[{productId:f.id,quantity:4}]});
 // Old application versions omitted this optional movement field. Keep all real
 // command-created quantities, row order and documents; remove only the field.
 await f.db.collection('stockMovements').updateMany({documentId:transfer},{$unset:{documentRevision:''}});
 await f.assertOpening({a:6,b:4},0);
 await f.run({type:'transfer.void',documentId:transfer});await f.assertOpening({a:10},0);
});

test('adversarial provenance: cross-warehouse purchase substitutes refund native opening when count and transfer are later reversed',async t=>{
 const f=await fixture(t),purchase=await f.purchase(5),sale=await f.sale(10),transfer=await f.transfer('a','c',3);
 const count=await f.run({type:'adjustment.post',warehouseId:'c',reason:'Audit cross-warehouse shortage',lines:[{productId:f.id,actualQuantity:1}]});
 await f.voidSale(sale);await f.voidPurchase(purchase);
 assert.deepEqual((await f.product()).stocks,{a:7,c:1});await f.assertOpening({a:7,c:1},2);
 await f.voidCount(count);await f.assertOpening({a:7,c:3},0);
 await f.run({type:'transfer.void',documentId:transfer});await f.assertOpening({a:10},0);
 assert.deepEqual((await f.product()).stocks,{a:10,c:0});
});

test('adversarial provenance: a source-edited partially consumed transfer never creates opening stock and all inverse operations restore it',async t=>{
 const f=await fixture(t),purchase=await f.purchase(10,'c'),transfer=await f.transfer('a','b',8),sale=await f.sale(5,'b');
 await f.run({type:'transfer.update',documentId:transfer,fromWarehouseId:'c',toWarehouseId:'b',lines:[{productId:f.id,quantity:6}]});
 assert.equal((await f.state()).consumed,5);
 await f.assertOpening((await f.state()).allocations,5);
 await assert.rejects(f.run({type:'opening-stock-initial.void',documentId:(await f.opening()).id}),/تم التصرف|لا يمكن خفض/);
 await f.voidSale(sale);await f.assertOpening((await f.state()).allocations,0);
 await f.run({type:'transfer.void',documentId:transfer});await f.assertOpening((await f.state()).allocations,0);
 await f.voidPurchase(purchase);await f.assertOpening({a:10},0);
 assert.deepEqual((await f.product()).stocks,{a:10,c:0,b:0});
});

test('adversarial provenance: bottle count decrease undo and later sale undo restore two independent withdrawals exactly once',async t=>{
 const f=await fixture(t,{bottle:true}),count=await f.count(8),sale=await f.sale(2);
 await f.assertOpening({a:6},4);
 await f.voidCount(count);await f.assertOpening({a:8},2);
 await f.voidSale(sale);await f.assertOpening({a:10},0);
 await assert.rejects(f.voidCount(count),/ملغاة|غير موجود/);await f.assertOpening({a:10},0);
});

test('adversarial provenance: reversing a positive bottle count removes its own added source before native opening',async t=>{
 const f=await fixture(t,{bottle:true}),count=await f.count(14),sale=await f.sale(2);
 await f.assertOpening({a:8},2);
 await f.voidCount(count);assert.equal((await f.product()).stocks.a,8);await f.assertOpening({a:8},2);
 await f.voidSale(sale);await f.assertOpening({a:10},0);
});
