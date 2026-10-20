import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHarness } from './sqlite-harness.mjs';
import { execute, POST } from '../app/api/command/route.ts';
import { createSession } from '../lib/auth.ts';
import { GET as history } from '../app/api/history/route.ts';
import { canReadDocument, canReadDocumentKind } from '../lib/document-read-model.ts';
import { managementKind, managementInputFor } from '../app/perfume-management.ts';
import { productsWithCurrentCosts } from '../lib/product-cost.ts';

async function setup(t){
 const h=await sqliteHarness();await h.reset();t.after(()=>h.close());const db=h.db;
 await db.collection('warehouses').insertMany([{id:'w',name:'Stock',isSalesDefault:true},{id:'w2',name:'Other'}]);
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',balance:10000,isActive:true});
 await db.collection('products').insertOne({id:'source',name:'Original',stocks:{w:5},pieceCost:1000,lastPurchaseCost:1000,piecePrice:1500,perfumeForm:'full'});
 const cmd=body=>db.transaction(s=>execute(db,s,body));
 const product=id=>db.collection('products').findOne({id}),doc=id=>db.collection('documents').findOne({id});
 return {db,cmd,product,doc};
}
const split={type:'perfume-split.post',sourceProductId:'source',warehouseId:'w',divisionsCount:10,salePrice:150,note:'first'};
test('split edits produce linked revisions; cancel restores source and keeps documents and movement evidence',async t=>{
 const {db,cmd,doc,product}=await setup(t);const oldId=await cmd(split),old=await doc(oldId);
 assert.equal(managementKind(old),'split');assert.equal(old.note,'first');
 const newId=await cmd({...split,type:'perfume-management.update',documentId:oldId,expectedRevision:0,divisionsCount:8,note:'changed'});
 const revised=await doc(newId);assert.equal((await doc(oldId)).status,'voided');assert.equal((await doc(oldId)).replacedByDocumentId,newId);assert.equal(revised.replacesDocumentId,oldId);
 assert.equal((await product('source')).stocks.w,4);
 const p=await product(revised.decantProductId);assert.equal(p.stocks.w,8);assert.equal(p.perfumeLots[0].liquidUnitCost,125);
 await cmd({type:'perfume-management.void',documentId:newId,expectedRevision:1});
 assert.equal((await product('source')).stocks.w,5);assert.equal((await product(p.id)).isArchived,true);
 assert.equal(await db.collection('documents').countDocuments({}),2);assert.equal(await db.collection('financialMovements').countDocuments({}),0);
 assert.ok(await db.collection('stockMovements').countDocuments({documentId:oldId})>=4);
 await assert.rejects(cmd({type:'perfume-management.void',documentId:newId}),/ملغاة/);
});
test('failed edits and stale revisions roll back the reversal, stock and all history',async t=>{
 const {db,cmd,doc,product}=await setup(t),id=await cmd(split),d=await doc(id);
 const before=await db.collection('stockMovements').countDocuments({});
 await assert.rejects(cmd({...split,type:'perfume-management.update',documentId:id,expectedRevision:3}),/تغيرت/);
 await assert.rejects(cmd({...split,type:'perfume-management.update',documentId:id,expectedRevision:0,divisionsCount:1}),/عدد/);
 assert.equal((await doc(id)).status,'posted');assert.equal((await product('source')).stocks.w,4);assert.equal((await product(d.decantProductId)).stocks.w,10);
 assert.equal(await db.collection('stockMovements').countDocuments({}),before);
});
test('sale-dependent split cannot be canceled or edited; recombination can be reversed only while partial stock is intact',async t=>{
 const {db,cmd,doc,product}=await setup(t),id=await cmd(split),d=await doc(id);
 await db.collection('products').insertOne({id:'bottle',name:'bottle',perfumeForm:'bottle',stocks:{w:10},lastPurchaseCost:5,pieceCost:5});
 const sale=await cmd({type:'decant-sale.post',paymentMethod:'cash',cashAmount:150,lines:[{productId:d.decantProductId,quantity:1,unitPrice:150,bottleProductId:'bottle'}]});
 await assert.rejects(cmd({type:'perfume-management.void',documentId:id}),/حركات لاحقة/);
 const partialId=await cmd({type:'perfume-recombine.post',decantProductId:d.decantProductId,lotId:d.perfumeLotId,warehouseId:'w',salePrice:1300});
 assert.equal((await product(d.decantProductId)).stocks.w,0);assert.equal((await product(partialId)).pieceCost,900);
 const partSale=await cmd({type:'sale.post',warehouseId:'w',paymentMethod:'cash',cashAmount:1300,lines:[{productId:partialId,quantity:1,piecePrice:1300}]});
 const p=await product(partialId);assert.equal(p.stocks.w,0);
 const h=await (await import('../lib/sqlite.ts')).getDatabase();
 const recombine=await h.collection('documents').findOne({perfumeManagementType:'recombine',partialProductId:partialId});
 await assert.rejects(cmd({type:'perfume-management.void',documentId:recombine.id}),/حركات لاحقة/);
 await cmd({type:'sale.void',documentId:partSale});
 await cmd({type:'perfume-management.void',documentId:recombine.id});
 assert.equal((await product(partialId)).isArchived,true);assert.equal((await product(d.decantProductId)).stocks.w,9);
 await cmd({type:'decant-sale.void',documentId:sale});await cmd({type:'perfume-management.void',documentId:id});
 assert.equal((await product('source')).stocks.w,5);
});
test('opening, consumption and yield corrections are editable, noncash and reversed in dependency order',async t=>{
 const {db,cmd,doc,product}=await setup(t);
 const opening=await cmd({type:'perfume-opening.post',sourceProductId:'source',warehouseId:'w',quantity:8,remainingValue:800,salePrice:150});const d=await doc(opening);
 const input={decantProductId:d.decantProductId,lotId:d.perfumeLotId,warehouseId:'w',quantity:1,reason:'sample',reasonCode:'samples'};
 const used=await cmd({...input,type:'perfume-lot-consume.post'});
 const revised=await cmd({...input,type:'perfume-management.update',documentId:used,expectedRevision:0,quantity:2});
 assert.equal((await doc(revised)).inventoryLoss,200);assert.equal((await product(d.decantProductId)).stocks.w,6);
 const correction=await cmd({type:'perfume-lot-correct.post',decantProductId:d.decantProductId,lotId:d.perfumeLotId,warehouseId:'w',actualQuantity:7,reason:'yield'});
 assert.equal((await doc(correction)).bookValueAfter,600);
 await assert.rejects(cmd({type:'perfume-management.void',documentId:revised}),/دفعة التقسيم تغيرت/);
 await cmd({type:'perfume-management.void',documentId:correction});await cmd({type:'perfume-management.void',documentId:revised});
 assert.equal((await product(d.decantProductId)).stocks.w,8);await cmd({type:'perfume-management.void',documentId:opening});
 assert.equal((await product('source')).stocks.w,5);assert.equal(await db.collection('financialMovements').countDocuments({}),0);
});
test('bottle definitions edit/archive/restore with document history and no purchase-cost mutation',async t=>{
 const {db,cmd,doc,product}=await setup(t);
 const id=await cmd({type:'perfume-bottle.create',name:'Bottle',sizeMl:10,cost:5});
 let d=await db.collection('documents').findOne({managementProductId:id,status:'posted'});assert.equal(d.perfumeManagementType,'bottle');
 await cmd({type:'decant-purchase.post',paymentMethod:'cash',cashAmount:60,lines:[{productId:id,quantity:10,unitPrice:6}]});
 await cmd({type:'perfume-bottle.update',id,name:'New name',sizeMl:12,cost:4});
 assert.equal((await doc(d.id)).status,'voided');assert.equal((await product(id)).lastPurchaseCost,6);assert.equal((await product(id)).stocks.w,10);
 const priced=await productsWithCurrentCosts(db,[await product(id)]);assert.equal(priced[0].lastPurchaseCost,6);
 await assert.rejects(cmd({type:'perfume-bottle.archive',id}),/لها مخزون/);
 const adj=await cmd({type:'perfume-bottle-stock.post',bottleProductId:id,warehouseId:'w',actualQuantity:0,reason:'broken'});
 await cmd({type:'perfume-bottle.archive',id});assert.equal((await product(id)).isArchived,true);
 await cmd({type:'perfume-bottle.restore',id});assert.equal((await product(id)).isArchived,false);
 await cmd({type:'perfume-management.void',documentId:adj});assert.equal((await product(id)).stocks.w,10);
 assert.ok(await db.collection('documents').countDocuments({managementProductId:id})>=4);
});
test('generic adjustment endpoints cannot bypass lot guards or archive a decant definition document',async t=>{
 const {cmd,doc}=await setup(t),id=await cmd(split),d=await doc(id);
 for(const type of ['adjustment.update','adjustment.void'])await assert.rejects(cmd({type,documentId:id,warehouseId:'w',reason:'bypass',lines:[{productId:d.decantProductId,actualQuantity:100}]}),/إدارة التقسيمات/);
});
test('old split and recombine documents can be viewed, inferred and reversed without rewriting their history',async t=>{
 const {db,cmd,doc,product}=await setup(t),id=await cmd(split),d=await doc(id);
 const partial=await cmd({type:'perfume-recombine.post',decantProductId:d.decantProductId,lotId:d.perfumeLotId,warehouseId:'w',salePrice:1300});
 const recombine=await db.collection('documents').findOne({partialProductId:partial});
 const unset={perfumeManagementType:'',managementInput:'',perfumeLotBefore:'',perfumeLotAfter:'',perfumeLotId:'',decantProductId:'',partialProductId:''};
 await db.collection('documents').updateOne({id:recombine.id},{$unset:unset});
 await db.collection('documents').updateOne({id},{$unset:unset});
 const old=await doc(id);assert.equal(managementKind(old),'split');assert.equal(managementInputFor(old,[await product(d.decantProductId)]).divisionsCount,10);
 await cmd({type:'perfume-management.void',documentId:recombine.id});await cmd({type:'perfume-management.void',documentId:id});
 assert.equal((await product('source')).stocks.w,5);
});
test('read permissions permit management history only, not unrelated bank or stock documents',()=>{
 const access={can:c=>c==='perfume.divisions.view',customerPartyIds:new Set(),supplierPartyIds:new Set()};
 assert.equal(canReadDocumentKind('adjustment',access),true);
 assert.equal(canReadDocument({kind:'adjustment',perfumeConversionType:'perfume-split',status:'voided'},access),true);
 assert.equal(canReadDocument({kind:'adjustment'},access),false);
 assert.equal(canReadDocument({kind:'account-adjustment'},access),false);
 assert.equal(canReadDocument({kind:'decant-sale'},access),true);
});

test('recombination edits replace the partial bottle while retaining both source documents',async t=>{
 const {db,cmd,doc,product}=await setup(t),splitId=await cmd(split),s=await doc(splitId);
 const first=await cmd({type:'perfume-recombine.post',decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',salePrice:1400});
 const d=await db.collection('documents').findOne({partialProductId:first});
 const next=await cmd({type:'perfume-management.update',documentId:d.id,expectedRevision:0,decantProductId:s.decantProductId,lotId:s.perfumeLotId,warehouseId:'w',salePrice:1500,note:'price correction'});
 const updated=await doc(next);
 assert.equal((await product(first)).isArchived,true);assert.equal((await doc(d.id)).replacedByDocumentId,next);
 assert.equal(updated.note,'price correction');assert.equal((await product(updated.partialProductId)).piecePrice,1500);
 assert.equal((await product(s.decantProductId)).stocks.w,0);
 await cmd({type:'perfume-management.void',documentId:next,expectedRevision:1});
 assert.equal((await product(s.decantProductId)).stocks.w,10);
 await cmd({type:'perfume-management.void',documentId:splitId});assert.equal((await product('source')).stocks.w,5);
});

test('bottle metadata note is retained and historical purchase line is unchanged',async t=>{
 const {db,cmd,doc,product}=await setup(t);
 const id=await cmd({type:'perfume-bottle.create',name:'Glass',sizeMl:10,cost:5});
 const purchase=await cmd({type:'decant-purchase.post',paymentMethod:'cash',cashAmount:60,lines:[{productId:id,quantity:10,unitPrice:6}]});
 const original=await doc(purchase);
 const edit=await cmd({type:'perfume-bottle.update',id,name:'New glass name',sizeMl:12,cost:3,note:'Catalog correction only'});
 assert.equal((await doc(edit)).note,'Catalog correction only');assert.deepEqual(await doc(purchase),original);
 assert.equal((await product(id)).lastPurchaseCost,6);assert.equal(await db.collection('financialMovements').countDocuments({documentId:edit}),0);
});

test('failed replacement rolls back the reversal, stock, lot, document and audit movements',async t=>{
 const {db,cmd,doc}=await setup(t),id=await cmd(split);
 const snapshot=async()=>Promise.all(['products','documents','stockMovements','financialMovements'].map(name=>db.collection(name).find().toArray()));
 const before=await snapshot();
 await assert.rejects(cmd({...split,type:'perfume-management.update',documentId:id,expectedRevision:0,warehouseId:'missing'}),/المخزن غير موجود/);
 assert.deepEqual(await snapshot(),before);
 assert.equal((await doc(id)).status,'posted');
 await assert.rejects(cmd({...split,type:'perfume-management.update',documentId:id,expectedRevision:4}),/تغيرت العملية/);
 assert.deepEqual(await snapshot(),before);
 await cmd({type:'perfume-management.void',documentId:id});
 const reversed=await snapshot();
 await assert.rejects(cmd({type:'perfume-management.void',documentId:id}),/ملغاة أو تم تعديلها/);
 assert.deepEqual(await snapshot(),reversed);
});

test('stale bottle snapshots cannot overwrite a newer catalog revision',async t=>{
 const {db,cmd,product}=await setup(t);
 const id=await cmd({type:'perfume-bottle.create',name:'Glass',sizeMl:10,cost:5});
 const expectedProduct={name:'Glass',sizeMl:10,cost:5,isArchived:false};
 await cmd({type:'perfume-bottle.update',id,name:'New glass',sizeMl:12,cost:6,expectedProduct});
 const count=await db.collection('documents').countDocuments();
 await assert.rejects(cmd({type:'perfume-bottle.update',id,name:'Stale name',sizeMl:11,cost:4,expectedProduct}),/تغيرت الزجاجة/);
 assert.equal((await product(id)).name,'New glass');
 assert.equal(await db.collection('documents').countDocuments(),count);
});

test('HTTP management commands enforce permissions and idempotency; history retains voided revisions',async t=>{
 const {db,product}=await setup(t);
 await db.collection('users').insertMany([
  {id:'manager',isActive:true,name:'Manager',username:'manager',permissions:['perfume.divisions.manage','perfume.divisions.view']},
  {id:'viewer',isActive:true,name:'Viewer',username:'viewer',permissions:['perfume.divisions.view']},
 ]);
 const origin='http://127.0.0.1:3219';
 const request=(path,user,body,key='same-split')=>new Request(origin+path,{method:body?'POST':'GET',headers:{origin,host:'127.0.0.1:3219',cookie:`conta_session=${createSession({principalType:'user',userId:user})}`,'content-type':'application/json','Idempotency-Key':key},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await POST(request('/api/command','viewer',split))).status,403);
 const first=await POST(request('/api/command','manager',split));assert.equal(first.status,200);
 const result=await first.json();
 assert.deepEqual(await (await POST(request('/api/command','manager',split))).json(),result);
 assert.equal((await product('source')).stocks.w,4);
 assert.equal((await POST(request('/api/command','manager',{...split,divisionsCount:8}))).status,409);
 const voided=await POST(request('/api/command','manager',{type:'perfume-management.void',documentId:result.id},'void-split'));
 assert.equal(voided.status,200);assert.equal((await product('source')).stocks.w,5);
 const list=await history(request('/api/history?kind=adjustment&documentId='+result.id,'viewer'));
 assert.equal(list.status,200);
 assert.match(JSON.stringify(await list.json()),/voided/);
});

test('opening and yield edits preserve linked revisions and the unsold liquid book value',async t=>{
 const {db,cmd,doc,product}=await setup(t);
 const input={sourceProductId:'source',warehouseId:'w',quantity:8,remainingValue:800,salePrice:150};
 const first=await cmd({...input,type:'perfume-opening.post'});
 const next=await cmd({...input,type:'perfume-management.update',documentId:first,expectedRevision:0,quantity:10,remainingValue:1000});
 assert.equal((await doc(first)).replacedByDocumentId,next);
 const opening=await doc(next),p=await product(opening.decantProductId);
 assert.deepEqual([p.stocks.w,p.perfumeLots[0].liquidUnitCost],[10,100]);
 const correction={decantProductId:p.id,lotId:opening.perfumeLotId,warehouseId:'w',reason:'recount'};
 const oldYield=await cmd({...correction,type:'perfume-lot-correct.post',actualQuantity:12});
 const newYield=await cmd({...correction,type:'perfume-management.update',documentId:oldYield,expectedRevision:0,actualQuantity:11});
 const revised=await product(p.id),lot=revised.perfumeLots[0];
 assert.equal(revised.stocks.w,11);assert.ok(Math.abs(lot.remainingQuantity*lot.liquidUnitCost-1000)<1e-9);
 assert.equal((await doc(oldYield)).replacedByDocumentId,newYield);
 assert.equal((await doc(newYield)).replacesDocumentId,oldYield);
 await cmd({type:'perfume-management.void',documentId:newYield,expectedRevision:1});
 assert.deepEqual([(await product(p.id)).stocks.w,(await product(p.id)).perfumeLots[0].liquidUnitCost],[10,100]);
 await cmd({type:'perfume-management.void',documentId:next,expectedRevision:1});
 assert.equal((await product('source')).stocks.w,5);
 assert.equal(await db.collection('financialMovements').countDocuments(),0);
});

test('bottle quantity edits use historical cost and refuse reversal after added stock is consumed',async t=>{
 const {db,cmd,doc,product}=await setup(t);
 const id=await cmd({type:'perfume-bottle.create',name:'Glass',sizeMl:10,cost:5});
 const purchase=await cmd({type:'decant-purchase.post',paymentMethod:'cash',cashAmount:60,lines:[{productId:id,quantity:10,unitPrice:6}]});
 const purchaseBefore=await doc(purchase);
 const input={bottleProductId:id,warehouseId:'w',reason:'counted',cost:999};
 const first=await cmd({...input,type:'perfume-bottle-stock.post',actualQuantity:12});
 const next=await cmd({...input,type:'perfume-management.update',documentId:first,expectedRevision:0,actualQuantity:13});
 assert.equal((await product(id)).stocks.w,13);
 assert.equal((await doc(first)).replacedByDocumentId,next);
 assert.equal((await doc(next)).lines[0].unitPrice,6);
 assert.equal((await doc(next)).managementInput.cost,6);
 const sale=await cmd({type:'decant-sale.post',paymentMethod:'cash',cashAmount:120,lines:[{productId:id,quantity:12,unitPrice:10}]});
 await assert.rejects(cmd({type:'perfume-management.void',documentId:next}),/تم التصرف فيه/);
 assert.equal((await product(id)).stocks.w,1);assert.equal((await doc(next)).status,'posted');
 await cmd({type:'decant-sale.void',documentId:sale});
 await cmd({type:'perfume-management.void',documentId:next,expectedRevision:1});
 assert.equal((await product(id)).stocks.w,10);
 assert.deepEqual(await doc(purchase),purchaseBefore);
 assert.equal((await product(id)).lastPurchaseCost,6);
 assert.equal(await db.collection('financialMovements').countDocuments({documentId:next}),0);
});
