import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute} from '../app/api/command/route.ts';
import {deriveOpeningStockState} from '../lib/opening-stock.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertMany([{_id:'a',name:'A',isSalesDefault:true},{_id:'b',name:'B'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',balance:100000,openingBalance:100000,isActive:true});
 const run=body=>db.transaction(s=>execute(db,s,body));
 const full=await run({type:'product.create',name:'Native opening perfume',pieceCost:1000,piecePrice:2000,openingStock:10,openingWarehouseId:'a'});
 const bottle=await run({type:'perfume-bottle.create',name:'10 ml bottle',sizeMl:10,cost:20});
 await run({type:'product.update',id:bottle,name:'10 ml bottle',pieceCost:20,piecePrice:100,replaceOpeningStock:true,openingStock:10,openingCost:20,openingWarehouseId:'a'});
 const state=async id=>deriveOpeningStockState(db,undefined,await db.collection('products').findOne({id}));
 const opening=async id=>db.collection('documents').findOne({'lines.productId':id,title:'رصيد بداية'});
 const split=()=>run({type:'perfume-split.post',sourceProductId:full,warehouseId:'a',volumeMl:100,priceBasisMl:10,salePrice:200});
 return {db,run,full,bottle,state,opening,split};
}
test('A01 split and cancellation restore actual native opening provenance, not only the final balance',async t=>{
 const f=await fixture(t),split=await f.split();assert.equal((await f.state(f.full)).consumed,1);
 await f.run({type:'perfume-management.void',documentId:split});
 const state=await f.state(f.full);assert.deepEqual([state.total,state.remaining,state.consumed],[10,10,0]);
 await f.run({type:'opening-stock-initial.void',documentId:(await f.opening(f.full)).id});
 assert.equal((await f.db.collection('products').findOne({id:f.full})).stocks.a,0);
});
test('A01 empty bottle sale cancellation restores its native opening source',async t=>{
 const f=await fixture(t),sale=await f.run({type:'decant-sale.post',paymentMethod:'cash',lines:[{productId:f.bottle,quantity:2,unitPrice:100}]});
 assert.equal((await f.state(f.bottle)).consumed,2);await f.run({type:'decant-sale.void',documentId:sale});
 assert.deepEqual([(await f.state(f.bottle)).remaining,(await f.state(f.bottle)).consumed],[10,0]);
});
test('A01 bottle purchase reversal never consumes unrelated native opening stock',async t=>{
 const f=await fixture(t),purchase=await f.run({type:'decant-purchase.post',paymentMethod:'cash',lines:[{productId:f.bottle,quantity:5,unitPrice:25}]});
 await f.run({type:'decant-purchase.void',documentId:purchase});assert.equal((await f.state(f.bottle)).remaining,10);
});
test('A01 purchase moved between warehouses does not consume original opening units',async t=>{
 const f=await fixture(t),purchase=await f.run({type:'purchase.post',warehouseId:'a',paymentMethod:'cash',lines:[{productId:f.full,quantity:5,unitPrice:1100}]});
 await f.run({type:'purchase.update',documentId:purchase,warehouseId:'b',paymentMethod:'cash',lines:[{productId:f.full,quantity:5,unitPrice:1100}]});
 const state=await f.state(f.full);assert.deepEqual([state.remaining,state.consumed,state.allocations.a],[10,0,10]);
});
test('A01 unrelated purchase cannot make an actually sold opening source deletable',async t=>{
 const f=await fixture(t);await f.run({type:'sale.post',warehouseId:'a',paymentMethod:'cash',lines:[{productId:f.full,quantity:1,piecePrice:2000}]});
 await f.run({type:'purchase.post',warehouseId:'a',paymentMethod:'cash',lines:[{productId:f.full,quantity:1,unitPrice:1100}]});
 assert.deepEqual([(await f.state(f.full)).remaining,(await f.state(f.full)).consumed],[9,1]);
 await assert.rejects(f.run({type:'opening-stock-initial.void',documentId:(await f.opening(f.full)).id}),/تم التصرف|لا يمكن خفض/);
});
