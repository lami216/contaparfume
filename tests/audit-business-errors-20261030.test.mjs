import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {POST} from '../app/api/command/route.ts';
import {createSession,CAPABILITIES} from '../lib/auth.ts';
import {serializeBusinessError,BUSINESS_ERROR_LIMITS} from '../lib/business-error.ts';

const isPerfume=CAPABILITIES.includes('perfume.divisions.manage');
async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db,oldProfile=process.env.ALKARNA_USER_DATA;
 process.env.ALKARNA_USER_DATA=h.directory;t.after(()=>{if(oldProfile===undefined)delete process.env.ALKARNA_USER_DATA;else process.env.ALKARNA_USER_DATA=oldProfile});
 await db.collection('warehouses').insertOne({_id:'w',name:'Test warehouse',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Cash',isActive:true,balance:10000,openingBalance:10000});
 await db.collection('users').insertMany([{id:'manager',username:'manager',name:'Manager',isActive:true,permissions:['products.create','products.edit','products.view','warehouses.adjust','warehouses.adjust.edit','warehouses.adjust.delete','pos.create','pos.delete',...(isPerfume?['perfume.divisions.manage']:[])]},{id:'viewer',username:'viewer',name:'Viewer',isActive:true,permissions:['products.view']}]);
 const origin='http://127.0.0.1:3219',tokens={manager:createSession({principalType:'user',userId:'manager'}),viewer:createSession({principalType:'user',userId:'viewer'})};
 const post=async(body,key,user='manager')=>{const response=await POST(new Request(origin+'/api/command',{method:'POST',headers:{origin,host:'127.0.0.1:3219',cookie:'conta_session='+tokens[user],'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()}};
 const successful=async(body,key)=>{const r=await post(body,key);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id};
 const productId=await successful({type:'product.create',name:'Opening fixture',openingStock:5,openingWarehouseId:'w',pieceCost:10,piecePrice:20},'create-product');
 const opening=await db.collection('documents').findOne({kind:'adjustment','lines.productId':productId,status:'posted'});
 const sale=quantity=>successful({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId,quantity,piecePrice:20}]},'sale-'+quantity);
 const snapshot=()=>Promise.all(['products','documents','stockMovements','financialMovements','paymentAccounts','commandReceipts','auditEvents'].map(n=>db.collection(n).find().toArray()));
 return{h,db,post,successful,productId,opening,sale,snapshot};
}

test('A07 actual POST preserves initial-opening source blockers and permits same-key retry after the dependency is voided',async t=>{
 const f=await fixture(t),sale=await f.sale(3),body={type:'opening-stock-initial.void',documentId:f.opening.id},before=await f.snapshot();
 const blocked=await f.post(body,'retry-opening');assert.equal(blocked.status,409);assert.equal(blocked.body.code,'OPENING_STOCK_BLOCKED');assert.equal(blocked.body.productId,f.productId);assert.equal(blocked.body.consumedOpening,3);assert(Array.isArray(blocked.body.deficits));assert(Array.isArray(blocked.body.blockers));assert(blocked.body.blockers.some(b=>b.documentId===sale));
 assert.deepEqual(await f.snapshot(),before);assert.equal(await f.db.collection('commandReceipts').findOne({_id:'retry-opening'}),null);
 await f.successful({type:'sale.void',documentId:sale},'void-sale');const retried=await f.post(body,'retry-opening');assert.equal(retried.status,200);assert.equal(retried.body.id,f.opening.id);
 const completed=await f.snapshot();assert.deepEqual(await f.post(body,'retry-opening'),retried);assert.deepEqual(await f.snapshot(),completed);
 assert.equal((await f.db.collection('commandReceipts').findOne({_id:'retry-opening'})).status,'committed');
});

test('A07 actual POST preserves correction blockers and does not strand a failed receipt',async t=>{
 const f=await fixture(t);await f.successful({type:'product.update',id:f.productId,name:'Opening fixture',pieceCost:10,piecePrice:20,replaceOpeningStock:true,openingStock:8,openingCost:10,openingWarehouseId:'w'},'increase-opening');
 const correction=await f.db.collection('documents').findOne({openingCorrection:true}),sale=await f.sale(6),body={type:'opening-stock-correction.void',documentId:correction.id},before=await f.snapshot();
 const blocked=await f.post(body,'retry-correction');assert.equal(blocked.status,409);assert.equal(blocked.body.code,'OPENING_CORRECTION_BLOCKED');assert.equal(blocked.body.productId,f.productId);assert(Array.isArray(blocked.body.deficits));assert(blocked.body.blockers.some(b=>b.documentId===sale));assert.deepEqual(await f.snapshot(),before);
 await f.successful({type:'sale.void',documentId:sale},'void-correction-sale');const retried=await f.post(body,'retry-correction');assert.equal(retried.status,200);const saved=await f.snapshot();assert.deepEqual(await f.post(body,'retry-correction'),retried);assert.deepEqual(await f.snapshot(),saved);
});

test('A07 permission rejection does not disclose blockers or mutate the command receipt ledger',async t=>{
 const f=await fixture(t);await f.sale(1);const before=await f.snapshot(),denied=await f.post({type:'opening-stock-initial.void',documentId:f.opening.id},'denied-opening','viewer');
 assert.equal(denied.status,403);assert.equal(denied.body.code,undefined);assert.equal(denied.body.blockers,undefined);assert.deepEqual(await f.snapshot(),before);
});

test('A07 real internal SQLite failure sends a generic response and rolls back the receipt and stock',async t=>{
 const f=await fixture(t),before=await f.snapshot();
 f.db.native.exec("CREATE TRIGGER audit_private_failure BEFORE UPDATE ON products BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL_SECRET'); END");
 const failed=await f.post({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:f.productId,quantity:1,piecePrice:20}]},'internal-failure');
 assert.equal(failed.status,500);assert.deepEqual(failed.body,{error:'تعذر تنفيذ العملية'});assert.deepEqual(await f.snapshot(),before);
});

test('business error serialization allows only known nested opening fields and finite values',()=>{
 const details={code:'OPENING_STOCK_BLOCKED',productId:'p',productName:'Product',consumedOpening:3,restoredOpening:0,sql:'PRIVATE_SQL',password:'PRIVATE_PASSWORD',stack:'PRIVATE_STACK',deficits:[{warehouseId:'w',required:5,available:2,missing:3,secret:'PRIVATE_NESTED'}, {warehouseId:'bad',required:Infinity,available:0,missing:1}],blockers:[{documentId:'sale',documentNumber:'SAL-1',kind:'sale',title:'Sale',status:'posted',occurredAt:'2026-10-30T12:00:00Z',sql:'PRIVATE_NESTED',movementTypes:['sale',{}],warehouses:[{warehouseId:'w',warehouseName:'Warehouse',quantityDelta:-3,secret:'PRIVATE_NESTED'},{warehouseId:'bad',quantityDelta:NaN}]}]};
 const response=serializeBusinessError(Object.assign(new Error('Public business message'),{status:409,details,secret:'PRIVATE_TOP'}));
 assert.equal(response.status,409);assert.equal(response.body.code,details.code);assert.equal(response.body.consumedOpening,3);assert.equal(response.body.restoredOpening,0);assert.equal(response.body.deficits.length,1);assert.equal(response.body.blockers.length,1);assert.deepEqual(response.body.blockers[0].movementTypes,['sale']);assert.equal(response.body.blockers[0].warehouses.length,1);assert(!JSON.stringify(response).includes('PRIVATE_'));
});

test('business error serialization preserves direct perfume dependencies with a bounded whitelist',()=>{
 const response=serializeBusinessError(Object.assign(new Error('Blocked'),{status:409,code:'PERFUME_OPERATION_BLOCKED',dependencies:[{documentId:'d',number:'D-1',label:'Conversion',occurredAt:'2026-10-30',stack:'PRIVATE_STACK',password:'PRIVATE_PASSWORD'}, {documentId:{toString:()=>{throw Error('Must not stringify')}},number:'bad'}]}));
 assert.equal(response.body.code,'PERFUME_OPERATION_BLOCKED');assert.deepEqual(response.body.dependencies,[{documentId:'d',number:'D-1',label:'Conversion',occurredAt:'2026-10-30'}]);assert(!JSON.stringify(response).includes('PRIVATE_'));
});

test('business error serialization never sends unknown details or internal errors',()=>{
 const unknown=serializeBusinessError(Object.assign(new Error('Public'),{status:409,code:'UNKNOWN_CODE',details:{code:'UNKNOWN_CODE',stack:'PRIVATE_STACK',password:'PRIVATE_PASSWORD'}}));assert.deepEqual(unknown,{status:409,body:{error:'Public'}});
 for(const status of [undefined,500,503,NaN,Infinity,200,399,600,999]){const response=serializeBusinessError(Object.assign(new Error('PRIVATE_SQL_STACK'),{status,code:'PERFUME_OPERATION_BLOCKED',dependencies:[{documentId:'PRIVATE_SECRET'}],details:{code:'OPENING_STOCK_BLOCKED',productId:'PRIVATE_SECRET'}}));assert.equal(response.status,status===503?503:500);assert.deepEqual(response.body,{error:'تعذر تنفيذ العملية'});}
});

test('business error serialization bounds strings and nested arrays without invoking getters or object coercion',()=>{
 let invoked=0;const malicious={toString(){invoked++;return'PRIVATE_SECRET'}};
 const source={code:'OPENING_CORRECTION_BLOCKED',productId:'p'.repeat(1000),productName:'n'.repeat(1000),consumedOpening:NaN,restoredOpening:Infinity,blockers:Array.from({length:150},(_,i)=>({documentId:'d'+i,title:'t'.repeat(1000),movementTypes:Array(50).fill('sale'),warehouses:Array.from({length:50},(_,j)=>({warehouseId:'w'+j,warehouseName:'W',quantityDelta:-1})),get password(){invoked++;return'PRIVATE_SECRET'}})),deficits:[]};
 const response=serializeBusinessError(Object.assign(new Error('m'.repeat(3000)),{status:409,details:source}));assert.equal(response.body.error.length,BUSINESS_ERROR_LIMITS.message);assert.equal(response.body.productId.length,BUSINESS_ERROR_LIMITS.identifier);assert.equal(response.body.productName.length,BUSINESS_ERROR_LIMITS.label);assert.equal(response.body.blockers.length,BUSINESS_ERROR_LIMITS.items);assert.equal(response.body.blockers[0].title.length,BUSINESS_ERROR_LIMITS.title);assert.equal(response.body.blockers[0].warehouses.length,BUSINESS_ERROR_LIMITS.nestedItems);assert.equal(response.body.blockers[0].movementTypes.length,BUSINESS_ERROR_LIMITS.nestedItems);assert.equal(response.body.consumedOpening,undefined);assert.equal(response.body.restoredOpening,undefined);
 assert.deepEqual(serializeBusinessError(Object.assign(new Error('Public'),{status:409,details:{code:malicious}})).body,{error:'Public'});
 const getter={get code(){invoked++;return'OPENING_STOCK_BLOCKED'}};assert.deepEqual(serializeBusinessError(Object.assign(new Error('Public'),{status:409,details:getter})).body,{error:'Public'});assert.equal(invoked,0);
});

test('business error serialization retains existing opening-correction and product-archive confirmation contracts',()=>{
 const correction=serializeBusinessError(Object.assign(new Error('Correct first'),{status:409,details:{code:'OPENING_INITIAL_HAS_CORRECTION',productId:'p',correctionDocumentId:'correction',password:'PRIVATE_SECRET'}}));assert.deepEqual(correction.body,{error:'Correct first',code:'OPENING_INITIAL_HAS_CORRECTION',productId:'p',correctionDocumentId:'correction'});
 const archive=serializeBusinessError(Object.assign(new Error('Confirm archive'),{status:409,details:{code:'PRODUCT_ARCHIVE_STOCK_CONFIRMATION_REQUIRED',stock:[{warehouseId:'w',quantity:3,sql:'PRIVATE_SECRET'},{warehouseId:'bad',quantity:Infinity}]}}));assert.deepEqual(archive.body,{error:'Confirm archive',code:'PRODUCT_ARCHIVE_STOCK_CONFIRMATION_REQUIRED',stock:[{warehouseId:'w',quantity:3}]});
});

if(isPerfume)test('A07 actual perfume operation dependencies survive the shared business-error boundary',async t=>{
 const f=await fixture(t),body={type:'perfume-split.post',sourceProductId:f.productId,warehouseId:'w',volumeMl:100,salePrice:20},split=await f.successful(body,'first-split'),before=await f.snapshot();
 const blocked=await f.post(body,'blocked-split');assert.equal(blocked.status,409);assert.equal(blocked.body.code,'PERFUME_OPERATION_BLOCKED');assert(blocked.body.dependencies.some(d=>d.documentId===split));assert.deepEqual(await f.snapshot(),before);
});
