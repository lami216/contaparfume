import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute,POST} from '../app/api/command/route.ts';
import {execute as executeCore} from '../app/api/command/core-route.ts';
import {GET as bootstrap} from '../app/api/bootstrap/route.ts';
import {createSession} from '../lib/auth.ts';
import {ensurePerfumeSystemCategories,perfumeSystemCategoryId,perfumeSystemCategoryKind} from '../lib/perfume-system-categories.ts';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup,stringifyBackup} from '../lib/backup.ts';

const decants='system:perfume:decants',bottles='system:perfume:bottles';
async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertOne({_id:'w',name:'Trial warehouse',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000});
 await db.collection('productCategories').insertMany([{id:'full-category',name:'العطور الأصلية'},{id:'custom',name:'فئة خاصة'}]);
 await db.collection('products').insertOne({id:'full',sku:'1',name:'Source perfume',categoryId:'full-category',perfumeForm:'full',pieceCost:1000,openingCost:1000,lastPurchaseCost:1000,piecePrice:1500,stocks:{w:3}});
 const run=body=>db.transaction(s=>execute(db,s,body));
 const core=body=>db.transaction(s=>executeCore(db,s,body));
 const ensure=()=>db.transaction(s=>ensurePerfumeSystemCategories(db,s));
 const product=id=>db.collection('products').findOne({id});
 const snapshot=()=>Promise.all(['products','productCategories','documents','stockMovements','financialMovements','paymentAccounts'].map(name=>db.collection(name).find().sort({id:1}).toArray()));
 const request=(body,key,token)=>new Request('http://localhost/api/command',{method:'POST',headers:{Host:'localhost',Origin:'http://localhost','Content-Type':'application/json','Idempotency-Key':key,...(token?{Cookie:`conta_session=${token}`}:{})},body:JSON.stringify(body)});
 return{db,run,core,ensure,product,snapshot,request};
}

test('system categories backfill only classification, remain idempotent and preserve custom names and historical snapshots',async t=>{
 const f=await fixture(t);
 await f.db.collection('products').insertMany([
  {id:'old-decant',sku:'2',name:'Old liquid',perfumeForm:'decant',parentProductId:'full',categoryId:'custom',stocks:{w:35},perfumeLots:[{id:'old-lot',remainingQuantity:35,liquidUnitCost:10,stocks:{w:35}}]},
  {id:'old-bottle',sku:'3',name:'Archived bottle',perfumeForm:'bottle',categoryId:null,isArchived:true,stocks:{w:0}},
  {id:'ordinary-partial',sku:'4',name:'Old custom partial',perfumeForm:'partial',parentProductId:'full',categoryId:'custom',stocks:{w:1}},
  {id:'inherited-partial',sku:'5',name:'Inherited partial',perfumeForm:'partial',parentProductId:'full',categoryId:decants,stocks:{w:1}},
 ]);
 await f.db.collection('documents').insertOne({id:'historic',kind:'sale',status:'posted',categoryId:'custom',lines:[{productId:'old-decant',categoryId:'custom',description:'Historic name',quantity:1,costAtSale:10}]});
 const before=await f.snapshot();await f.ensure();
 assert.equal((await f.product('old-decant')).categoryId,decants);assert.equal((await f.product('old-bottle')).categoryId,bottles);
 assert.equal((await f.product('full')).categoryId,'full-category');assert.equal((await f.product('ordinary-partial')).categoryId,'custom');assert.equal((await f.product('inherited-partial')).categoryId,'full-category');
 const after=await f.snapshot(),withoutCategory=rows=>rows.map(row=>{const copy={...row};delete copy.categoryId;return copy;});
 assert.deepEqual(withoutCategory(after[0]),withoutCategory(before[0]));assert.deepEqual(after.slice(2),before.slice(2));
 await f.run({type:'product-category.update',id:decants,name:'عينات العطر'});await f.run({type:'product-category.update',id:bottles,name:'عبوات العينات'});
 const once=await f.snapshot();await f.ensure();await f.ensure();assert.deepEqual(await f.snapshot(),once);
 assert.equal((await f.db.collection('productCategories').findOne({id:'custom'})).name,'فئة خاصة');
 assert.equal((await f.db.collection('productCategories').findOne({id:decants})).name,'عينات العطر');
 assert.equal(perfumeSystemCategoryKind(decants),'perfume-decants');assert.equal(perfumeSystemCategoryKind('custom'),null);
 assert.equal(perfumeSystemCategoryId('partial'),null);
});

test('actual bottle, legacy split, millilitre split and opening commands assign their system categories atomically',async t=>{
 const f=await fixture(t),bottle=await f.run({type:'perfume-bottle.create',name:'Ten ml bottle',sizeMl:10,cost:20,categoryId:'custom'});
 assert.equal((await f.product(bottle)).categoryId,bottles);
 await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',divisionsCount:10,salePrice:200});
 const legacy=await f.db.collection('products').findOne({perfumeForm:'decant',parentProductId:'full'});assert.equal(legacy.categoryId,decants);
 await f.db.collection('products').insertMany([
  {id:'volume-full',sku:'20',name:'Volume perfume',categoryId:'custom',pieceCost:2000,openingCost:2000,lastPurchaseCost:2000,stocks:{w:1}},
  {id:'opening-full',sku:'21',name:'Already open perfume',categoryId:'full-category',pieceCost:1000,openingCost:1000,lastPurchaseCost:1000,stocks:{w:0}},
 ]);
 await f.run({type:'perfume-split.post',sourceProductId:'volume-full',warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 await f.run({type:'perfume-opening.post',sourceProductId:'opening-full',warehouseId:'w',volumeMl:40,originalVolumeMl:100,salePrice:200,priceBasisMl:10});
 for(const parentProductId of ['volume-full','opening-full'])assert.equal((await f.db.collection('products').findOne({perfumeForm:'decant',parentProductId})).categoryId,decants);
 assert.equal((await f.product('volume-full')).categoryId,'custom');assert.equal((await f.product('opening-full')).categoryId,'full-category');
});

test('legacy return preserves its uncategorized partial outside the generated system category',async t=>{
 const f=await fixture(t);await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',divisionsCount:10,salePrice:200});
 const liquid=await f.db.collection('products').findOne({perfumeForm:'decant'});
 await f.run({type:'perfume-recombine.post',decantProductId:liquid.id,lotId:liquid.perfumeLots[0].id,warehouseId:'w',salePrice:1700});
 const partial=await f.db.collection('products').findOne({perfumeForm:'partial'});assert.equal(partial.categoryId,undefined);assert.equal(partial.parentProductId,'full');
});

test('millilitre return inherits the original perfume ordinary category instead of the decant system category',async t=>{
 const f=await fixture(t);await f.run({type:'perfume-split.post',sourceProductId:'full',warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 const liquid=await f.db.collection('products').findOne({perfumeForm:'decant'});
 await f.run({type:'perfume-recombine.post',decantProductId:liquid.id,lotId:liquid.perfumeLots[0].id,warehouseId:'w',salePrice:1700});
 const partial=await f.db.collection('products').findOne({perfumeForm:'partial'});assert.equal(partial.categoryId,'full-category');assert.equal(partial.parentProductId,'full');
});

test('product boundary rejects manual system assignments and prevents generated products leaving or swapping categories',async t=>{
 const f=await fixture(t);await f.ensure();
 const bottle=await f.run({type:'perfume-bottle.create',name:'Bottle',sizeMl:5,cost:15});
 for(const run of [f.run,f.core]){
  for(const categoryId of [decants,bottles]){
   const before=await f.snapshot();await assert.rejects(run({type:'product.create',name:'Spoof form',perfumeForm:'decant',categoryId}),/مخصصة تلقائيًا/);assert.deepEqual(await f.snapshot(),before);
   await assert.rejects(run({type:'product.update',id:'full',name:'Source perfume',categoryId}),/مخصصة تلقائيًا/);
  }
  for(const categoryId of [null,'','custom',decants])await assert.rejects(run({type:'product.update',id:bottle,name:'Bottle',categoryId}),/فئة هذا المنتج تلقائية/);
  await run({type:'product.update',id:bottle,name:'Renamed bottle',pieceCost:15});assert.equal((await f.product(bottle)).categoryId,bottles);
 }
 const ordinary=await f.run({type:'product.create',name:'Ordinary product',categoryId:'custom',systemKind:'perfume-decants'});
 assert.equal((await f.product(ordinary)).categoryId,'custom');assert.equal((await f.product(ordinary)).perfumeForm,undefined);
});

test('system category rename uses products.edit while deletion/spoofing is rejected and ordinary category behavior remains',async t=>{
 const f=await fixture(t);await f.ensure();
 await f.db.collection('users').insertMany([{id:'editor',username:'editor',name:'Editor',isActive:true,permissions:['products.edit']},{id:'deleter',username:'deleter',name:'Deleter',isActive:true,permissions:['products.delete']}]);
 const editor=createSession({principalType:'user',userId:'editor'}),deleter=createSession({principalType:'user',userId:'deleter'});
 const renamed=await POST(f.request({type:'product-category.update',id:decants,name:'عطور مقسمة',systemKind:'forged'},'system-rename',editor));assert.equal(renamed.status,200);
 assert.equal((await f.db.collection('productCategories').findOne({id:decants})).systemKind,'perfume-decants');
 const denied=await POST(f.request({type:'product-category.delete',id:decants},'system-delete-editor',editor));assert.equal(denied.status,403);
 const blocked=await POST(f.request({type:'product-category.delete',id:decants},'system-delete',deleter));assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/لا يمكن حذفها/);
 for(const run of [f.run,f.core]){
  await assert.rejects(run({type:'product-category.delete',id:bottles}),/لا يمكن حذفها/);
  await assert.rejects(run({type:'product-category.create',id:decants,name:'Fake'}),/فئات التقسيمات تلقائية/);
  await assert.rejects(run({type:'product-category.create',name:'Fake',systemKind:'perfume-bottles'}),/فئات التقسيمات تلقائية/);
 }
 const ordinary=await f.run({type:'product-category.create',name:'New ordinary'});
 await f.run({type:'product.update',id:'full',name:'Source perfume',categoryId:ordinary});
 await f.run({type:'product-category.update',id:ordinary,name:'Renamed ordinary'});await f.run({type:'product-category.delete',id:ordinary});assert.equal((await f.product('full')).categoryId,null);
});

test('authenticated bootstrap exposes canonical system identity without trusting a forged ordinary category field',async t=>{
 const f=await fixture(t);await f.db.collection('productCategories').updateOne({id:'custom'},{$set:{systemKind:'perfume-decants'}});
 await f.db.collection('products').insertOne({id:'historic-decant',sku:'11',name:'Historic decant',perfumeForm:'decant',stocks:{w:12},categoryId:'custom'});
 await f.db.collection('users').insertOne({id:'viewer',username:'viewer',name:'Viewer',isActive:true,permissions:['products.view']});
 const token=createSession({principalType:'user',userId:'viewer'}),response=await bootstrap(new Request('http://localhost/api/bootstrap',{headers:{Cookie:`conta_session=${token}`}}));assert.equal(response.status,200);const data=await response.json();
 assert.equal(data.categories.find(category=>category.id===decants).systemKind,'perfume-decants');
 assert.equal(data.categories.find(category=>category.id===bottles).systemKind,'perfume-bottles');
 assert.equal(data.categories.find(category=>category.id==='custom').systemKind,undefined);
 assert.equal(data.products.find(product=>product.id==='historic-decant').categoryId,decants);
});

test('seeding never repurposes an ordinary category with the same default name or a forged system kind',async t=>{
 const f=await fixture(t);await f.db.collection('productCategories').insertMany([{id:'old-user-category',name:'التقسيمات',systemKind:'perfume-decants'},{id:'old-suffixed',name:'التقسيمات (تلقائية)'}]);
 await f.db.collection('products').updateOne({id:'full'},{$set:{categoryId:'old-user-category'}});await f.ensure();
 assert.equal((await f.product('full')).categoryId,'old-user-category');assert.equal((await f.db.collection('productCategories').findOne({id:'old-user-category'})).name,'التقسيمات');
 assert.equal((await f.db.collection('productCategories').findOne({id:decants})).systemKind,'perfume-decants');
 const initialName=(await f.db.collection('productCategories').findOne({id:decants})).name;assert.equal(initialName,'التقسيمات (تلقائية 2)');
 for(const run of [f.run,f.core]){assert.equal(await run({type:'product-category.update',id:decants,name:initialName}),decants);await assert.rejects(run({type:'product-category.update',id:decants,name:'التقسيمات'}),/هذه الفئة موجودة/);}
 await f.run({type:'product-category.update',id:decants,name:'عينات الزبائن'});
 assert.equal((await f.db.collection('productCategories').findOne({id:'old-user-category'})).name,'التقسيمات');
});

test('native backup round-trip preserves system names and classifications without touching accounting history',async t=>{
 const f=await fixture(t);await f.run({type:'perfume-bottle.create',name:'Backup bottle',sizeMl:10,cost:20});
 await f.run({type:'product-category.update',id:decants,name:'تقسيمات المتجر'});const before=await f.snapshot();
 const backup=parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
 await f.db.transaction(s=>restoreNativeBackup(f.db,backup,s));await f.ensure();
 assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.collection('productCategories').findOne({id:decants})).name,'تقسيمات المتجر');
});
