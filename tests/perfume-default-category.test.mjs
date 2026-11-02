import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {execute,POST} from '../app/api/command/route.ts';
import {execute as executeCore} from '../app/api/command/core-route.ts';
import {GET as bootstrap} from '../app/api/bootstrap/route.ts';
import {createSession} from '../lib/auth.ts';
import {ensurePerfumeSystemCategories} from '../lib/perfume-system-categories.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';

const canonical='system:perfume:fragrances',role='perfume-fragrances',decants='system:perfume:decants',bottles='system:perfume:bottles';
const tables=['products','productCategories','documents','stockMovements','financialMovements','paymentAccounts','warehouses','counters','auditEvents','commandReceipts','appSettings'];
async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db,previousProfile=process.env.ALKARNA_USER_DATA;
 process.env.ALKARNA_USER_DATA=h.directory;t.after(()=>{if(previousProfile===undefined)delete process.env.ALKARNA_USER_DATA;else process.env.ALKARNA_USER_DATA=previousProfile});
 await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('productCategories').insertMany([{id:'custom',name:'فئة اختبار خاصة'},{id:'another',name:'فئة أخرى'}]);
 const run=body=>db.transaction(session=>execute(db,session,body)),core=body=>db.transaction(session=>executeCore(db,session,body));
 const ensure=()=>db.transaction(session=>ensurePerfumeSystemCategories(db,session));
 const product=id=>db.collection('products').findOne({id}),category=id=>db.collection('productCategories').findOne({id});
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,await db.collection(name).find().sort({id:1,_id:1}).toArray()])));
 const request=(body,key,token)=>new Request('http://localhost/api/command',{method:'POST',headers:{Host:'localhost',Origin:'http://localhost','Content-Type':'application/json','Idempotency-Key':key,...(token?{Cookie:'conta_session='+token}:{})},body:JSON.stringify(body)});
 const post=async(body,key,token)=>{const response=await POST(request(body,key,token));return{status:response.status,body:await response.json()}};
 const bootstrapAs=async token=>{const response=await bootstrap(new Request('http://localhost/api/bootstrap',{headers:token?{Cookie:'conta_session='+token}:{}}));assert.equal(response.status,200);return response.json()};
 return{db,run,core,ensure,product,category,snapshot,post,bootstrapAs};
}
const strippedProducts=products=>products.map(product=>{const copy={...product};delete copy.categoryId;return copy});
const businessWithoutCategories=snapshot=>Object.fromEntries(Object.entries(snapshot).filter(([name])=>!['products','productCategories','appSettings'].includes(name)));

test('default fragrance category appears in real bootstrap and backfills only uncategorized classification, including archived products',async t=>{
 const f=await fixture(t);
 await f.db.collection('products').insertMany([
  {id:'ordinary',sku:'1',name:'Uncategorized perfume',pieceCost:100,piecePrice:200,note:'Keep this note',stocks:{w:4}},
  {id:'archived',sku:'2',name:'Archived perfume',categoryId:null,isArchived:true,archivedAt:'2026-01-01',stocks:{w:0}},
  {id:'custom-full',sku:'3',name:'Custom perfume',perfumeForm:'full',categoryId:'custom',stocks:{w:2},pieceCost:300},
 ]);
 await f.db.collection('documents').insertOne({id:'historic',number:'SYNTHETIC-OLD',kind:'sale',status:'posted',categoryId:'custom',lines:[{id:'old-line',productId:'ordinary',description:'Historical description',categoryId:null,quantity:1,unitPrice:200,costAtSale:100,lineTotal:200}]});
 const before=await f.snapshot(),data=await f.bootstrapAs();assert.equal(data.categories.filter(c=>c.systemKind===role).length,1);assert.equal(data.categories.find(c=>c.systemKind===role).id,canonical);assert.equal((await f.category(canonical)).name,'العطور');
 assert.equal(data.products.find(p=>p.id==='ordinary').categoryId,canonical);assert.equal(data.products.find(p=>p.id==='archived').categoryId,canonical);assert.equal(data.products.find(p=>p.id==='custom-full').categoryId,'custom');
 const after=await f.snapshot();assert.deepEqual(strippedProducts(after.products),strippedProducts(before.products));assert.deepEqual(businessWithoutCategories(after),businessWithoutCategories(before));
 const stable=await f.snapshot();await f.ensure();await f.ensure();assert.deepEqual(await f.snapshot(),stable);
});

test('an existing trimmed العطور category is adopted in place, renamed safely and never replaced by a later namesake',async t=>{
 const f=await fixture(t);await f.db.collection('productCategories').insertOne({id:'legacy-fragrance',name:'  العطور  ',note:'Existing category identity'});
 await f.db.collection('products').insertMany([{id:'already-classified',sku:'1',name:'Already classified',categoryId:'legacy-fragrance',stocks:{w:1}},{id:'unclassified',sku:'2',name:'Unclassified',stocks:{w:0}}]);
 const before=await f.snapshot(),{fragranceCategoryId}=await f.ensure();assert.equal(fragranceCategoryId,'legacy-fragrance');assert.equal(await f.category(canonical),null);assert.equal((await f.product('already-classified')).categoryId,'legacy-fragrance');assert.equal((await f.product('unclassified')).categoryId,'legacy-fragrance');assert.equal((await f.category('legacy-fragrance')).note,'Existing category identity');
 assert.deepEqual(strippedProducts((await f.snapshot()).products),strippedProducts(before.products));
 await f.run({type:'product-category.update',id:'legacy-fragrance',name:'عطور المتجر'});await f.run({type:'product-category.update',id:'another',name:'العطور'});await f.ensure();
 assert.equal((await f.db.collection('appSettings').findOne({_id:'perfume-fragrance-category'})).categoryId,'legacy-fragrance');
 const id=await f.run({type:'product.create',name:'New default after rename'});assert.equal((await f.product(id)).categoryId,'legacy-fragrance');
 const exposed=await f.bootstrapAs();assert.equal(exposed.categories.find(c=>c.id==='legacy-fragrance').systemKind,role);assert.equal(exposed.categories.find(c=>c.id==='another').systemKind,undefined);
 for(const run of [f.run,f.core])await assert.rejects(run({type:'product-category.delete',id:'legacy-fragrance'}),error=>error.status===409);
 await f.run({type:'product-category.delete',id:'another'});assert.equal((await f.category('legacy-fragrance')).name,'عطور المتجر');
});

test('real wrapper and core product creation choose default for empty categories, preserve custom choices and ignore a forged perfume form',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 for(const [index,run]of[f.run,f.core].entries()){
  for(const supplied of [undefined,null,'']){const id=await run({type:'product.create',name:'Synthetic new '+index+' '+String(supplied),...(supplied===undefined?{}:{categoryId:supplied})});assert.equal((await f.product(id)).categoryId,fragranceCategoryId)}
  for(const categoryId of ['custom',fragranceCategoryId]){const id=await run({type:'product.create',name:'Synthetic choice '+index+' '+categoryId,categoryId});assert.equal((await f.product(id)).categoryId,categoryId)}
  const forged=await run({type:'product.create',name:'Synthetic forged form '+index,perfumeForm:'bottle',systemKind:'perfume-bottles'});assert.equal((await f.product(forged)).categoryId,fragranceCategoryId);assert.equal((await f.product(forged)).perfumeForm,undefined);
 }
});

test('omitted category updates preserve a valid custom category while explicit null and blank choose the protected default',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 for(const run of[f.run,f.core]){
  const id=await run({type:'product.create',name:'Synthetic classified',categoryId:'custom',pieceCost:100,piecePrice:200,openingStock:3,openingWarehouseId:'w'}),initial=await f.product(id);
  const edit={type:'product.update',id,name:initial.name,pieceCost:100,piecePrice:200};
  await run(edit);assert.equal((await f.product(id)).categoryId,'custom');
  await run({...edit,categoryId:null});assert.equal((await f.product(id)).categoryId,fragranceCategoryId);
  await run({...edit,categoryId:'custom'});await run({...edit,categoryId:''});assert.equal((await f.product(id)).categoryId,fragranceCategoryId);
  assert.deepEqual((await f.product(id)).stocks,initial.stocks);assert.equal((await f.product(id)).openingCost,initial.openingCost);
 }
});

test('historical partial perfume inherits a valid original custom category and otherwise falls back to default',async t=>{
 const f=await fixture(t);await f.db.collection('products').insertMany([
  {id:'source',sku:'1',name:'Source custom',categoryId:'custom',stocks:{w:1}},
  {id:'source-default',sku:'2',name:'Source uncategorized',stocks:{w:1}},
  {id:'partial-custom',sku:'3',name:'Preserved partial',perfumeForm:'partial',categoryId:'another',parentProductId:'source',stocks:{w:1},partialVolumeMl:23,pieceCost:230},
  {id:'partial-inherit',sku:'4',name:'Inherited partial',perfumeForm:'partial',categoryId:null,parentProductId:'source',stocks:{w:1},partialVolumeMl:15,pieceCost:150},
  {id:'partial-forced-leak',sku:'5',name:'Old forced-category partial',perfumeForm:'partial',categoryId:decants,parentProductId:'source',stocks:{w:1},partialVolumeMl:8,pieceCost:80},
  {id:'partial-default',sku:'6',name:'Default partial',perfumeForm:'partial',parentProductId:'source-default',stocks:{w:1},partialVolumeMl:12,pieceCost:120},
  {id:'partial-no-parent',sku:'7',name:'No parent partial',perfumeForm:'partial',stocks:{w:0}},
 ]);
 const before=await f.snapshot(),{fragranceCategoryId}=await f.ensure();assert.equal((await f.product('partial-custom')).categoryId,'another');assert.equal((await f.product('partial-inherit')).categoryId,'custom');assert.equal((await f.product('partial-forced-leak')).categoryId,'custom');
 for(const id of ['source-default','partial-default','partial-no-parent'])assert.equal((await f.product(id)).categoryId,fragranceCategoryId);
 const after=await f.snapshot();assert.deepEqual(strippedProducts(after.products),strippedProducts(before.products));assert.deepEqual(businessWithoutCategories(after),businessWithoutCategories(before));
});

test('default protection rejects deletes and forged creation through both command boundaries without mutating any rows',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 for(const run of[f.run,f.core])for(const body of[
  {type:'product-category.delete',id:fragranceCategoryId},
  {type:'product-category.create',id:fragranceCategoryId,name:'Forged default'},
  {type:'product-category.create',name:'Forged default',systemKind:role},
  {type:'product-category.create',name:'Forged forced type',systemKind:'perfume-decants'},
 ]){const before=await f.snapshot();await assert.rejects(run(body),error=>error.status===409);assert.deepEqual(await f.snapshot(),before)}
 await f.run({type:'product-category.update',id:'custom',name:'Ordinary renamed',systemKind:role});
 await f.db.collection('productCategories').updateOne({id:'custom'},{$set:{systemKind:role}});
 const data=await f.bootstrapAs();assert.equal(data.categories.find(c=>c.id==='custom').systemKind,undefined);assert.equal(data.categories.find(c=>c.id===fragranceCategoryId).systemKind,role);
 await f.run({type:'product-category.delete',id:'custom'});assert(await f.category(fragranceCategoryId));
});

test('deleting a custom category atomically reassigns active and archived members while preserving invoices, stock and money',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 const id=await f.run({type:'product.create',name:'Synthetic sold perfume',categoryId:'custom',pieceCost:100,piecePrice:200,openingStock:4,openingWarehouseId:'w'});
 const sale=await f.run({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:id,quantity:1,piecePrice:200}]});
 await f.db.collection('documents').updateOne({id:sale},{$set:{categoryId:'custom'}});
 await f.db.collection('products').insertOne({id:'archived-member',sku:'99',name:'Archived custom partial',perfumeForm:'partial',categoryId:'custom',isArchived:true,archivedAt:'2026-01-01',stocks:{w:0},pieceCost:25,note:'Keep archived note'});
 const before=await f.snapshot(),body={type:'product-category.delete',id:'custom'};
 f.db.native.exec("CREATE TRIGGER fail_default_category_delete BEFORE DELETE ON product_categories WHEN json_extract(OLD.data_json,'$.id')='custom' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CATEGORY_DELETE_FAILURE'); END");
 const failed=await f.post(body,'custom-delete-retry');assert.equal(failed.status,500);assert.deepEqual(failed.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'custom-delete-retry'}),null);
 f.db.native.exec('DROP TRIGGER fail_default_category_delete');const saved=await f.post(body,'custom-delete-retry');assert.equal(saved.status,200);assert.equal(saved.body.id,'custom');
 assert.equal(await f.category('custom'),null);for(const member of[id,'archived-member'])assert.equal((await f.product(member)).categoryId,fragranceCategoryId);
 const after=await f.snapshot();assert.deepEqual(strippedProducts(after.products),strippedProducts(before.products));for(const name of['documents','stockMovements','financialMovements','paymentAccounts','warehouses','counters'])assert.deepEqual(after[name],before[name]);
 const report=await buildReport(f.db,parseReportFilters(new URL('http://localhost/api/reports?type=sales&allTime=true&categoryId='+encodeURIComponent(fragranceCategoryId))));assert.equal(report.summary.netSales,200);assert.equal(report.summary.cost,100);assert.equal(report.summary.profit,100);
 const stable=await f.snapshot();assert.deepEqual(await f.post(body,'custom-delete-retry'),saved);assert.deepEqual(await f.snapshot(),stable);
});

test('core custom-category deletion applies the same fallback and protected default rules',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure(),id=await f.core({type:'product.create',name:'Core custom member',categoryId:'another'});
 await f.core({type:'product-category.delete',id:'another'});assert.equal((await f.product(id)).categoryId,fragranceCategoryId);assert.equal(await f.category('another'),null);
 const before=await f.snapshot();await assert.rejects(f.core({type:'product-category.delete',id:fragranceCategoryId}),error=>error.status===409);assert.deepEqual(await f.snapshot(),before);
});

test('forced decant and bottle categories remain unchanged and ordinary products still cannot use them',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 const full=await f.run({type:'product.create',name:'Synthetic source',pieceCost:1000,piecePrice:1500,openingStock:1,openingWarehouseId:'w'});assert.equal((await f.product(full)).categoryId,fragranceCategoryId);
 const bottle=await f.run({type:'perfume-bottle.create',name:'Synthetic 10ml bottle',sizeMl:10,cost:20});await f.run({type:'perfume-split.post',sourceProductId:full,warehouseId:'w',volumeMl:100,salePrice:200,priceBasisMl:10});
 const liquid=await f.db.collection('products').findOne({perfumeForm:'decant'});assert.equal(liquid.categoryId,decants);assert.equal((await f.product(bottle)).categoryId,bottles);
 await f.run({type:'product-category.update',id:fragranceCategoryId,name:'عطور المحل'});await f.ensure();assert.equal((await f.product(liquid.id)).categoryId,decants);assert.equal((await f.product(bottle)).categoryId,bottles);
 for(const run of[f.run,f.core]){
  for(const categoryId of[decants,bottles])await assert.rejects(run({type:'product.create',name:'Forbidden category',categoryId}),error=>error.status===409);
  for(const id of[liquid.id,bottle])await assert.rejects(run({type:'product.update',id,name:'Forbidden reassignment',categoryId:fragranceCategoryId}),error=>error.status===409);
 }
 assert.equal((await f.product(liquid.id)).stocks.w,100);assert.equal((await f.product(full)).stocks.w,0);
});

test('actual POST preserves create/edit/delete capabilities and disallows making the default unprotected',async t=>{
 const f=await fixture(t),{fragranceCategoryId}=await f.ensure();
 await f.db.collection('users').insertMany([
  {id:'viewer',username:'viewer',name:'Synthetic viewer',isActive:true,permissions:['products.view']},
  {id:'creator',username:'creator',name:'Synthetic creator',isActive:true,permissions:['products.create']},
  {id:'editor',username:'editor',name:'Synthetic editor',isActive:true,permissions:['products.edit']},
  {id:'deleter',username:'deleter',name:'Synthetic deleter',isActive:true,permissions:['products.delete']},
 ]);
 const tokens=Object.fromEntries(['viewer','creator','editor','deleter'].map(userId=>[userId,createSession({principalType:'user',userId})]));
 const rename={type:'product-category.update',id:fragranceCategoryId,name:'عطور الاختبار',systemKind:'ordinary'};
 for(const user of['viewer','creator','deleter']){const before=await f.snapshot();const response=await f.post(rename,'denied-rename-'+user,tokens[user]);assert.equal(response.status,403);assert.deepEqual(await f.snapshot(),before)}
 const renamed=await f.post(rename,'allowed-rename',tokens.editor);assert.equal(renamed.status,200);const data=await f.bootstrapAs(tokens.viewer);assert.equal(data.categories.find(c=>c.id===fragranceCategoryId).systemKind,role);
 const before=await f.snapshot(),protectedDelete=await f.post({type:'product-category.delete',id:fragranceCategoryId},'protected-delete',tokens.deleter);assert.equal(protectedDelete.status,409);assert.deepEqual(await f.snapshot(),before);
 const created=await f.post({type:'product.create',name:'Created with default'},'create-default',tokens.creator);assert.equal(created.status,200);assert.equal((await f.product(created.body.id)).categoryId,fragranceCategoryId);
 const createDenied=await f.post({type:'product.create',name:'Not permitted'},'create-denied',tokens.editor);assert.equal(createDenied.status,403);
 await f.run({type:'product.update',id:created.body.id,name:'Created with default',categoryId:'custom'});const deleted=await f.post({type:'product-category.delete',id:'custom'},'allowed-custom-delete',tokens.deleter);assert.equal(deleted.status,200);assert.equal((await f.product(created.body.id)).categoryId,fragranceCategoryId);
});

test('invalid nonempty category references are rejected rather than silently losing a custom classification',async t=>{
 const f=await fixture(t);await f.ensure();
 for(const run of[f.run,f.core])for(const categoryId of['missing-category',123,false,{},[]]){const before=await f.snapshot();await assert.rejects(run({type:'product.create',name:'Invalid requested category',categoryId}),error=>error.status===(typeof categoryId==='string'?404:400));assert.deepEqual(await f.snapshot(),before)}
 await f.db.collection('products').insertOne({id:'dangling',sku:'99',name:'Synthetic dangling historical category',categoryId:'missing-category',stocks:{w:2},pieceCost:10});const before=await f.snapshot();await assert.rejects(f.ensure(),error=>error.status===409);assert.deepEqual(await f.snapshot(),before);
});
