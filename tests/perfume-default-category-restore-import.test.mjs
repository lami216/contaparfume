import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import {sqliteHarness} from './sqlite-harness.mjs';
import {BACKUP_COLLECTIONS,createNativeBackup,parseAndValidateBackup,restoreNativeBackup,stringifyBackup} from '../lib/backup.ts';
import {executeLegacyImportPhase} from '../legacy/dataacc-sqlite.ts';
import {ensurePerfumeSystemCategories} from '../lib/perfume-system-categories.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';

const canonical='system:perfume:fragrances',decants='system:perfume:decants',bottles='system:perfume:bottles',adopted='existing-fragrances';
function fixtureBackup(){
 const collections=Object.fromEntries(BACKUP_COLLECTIONS.map(name=>[name,[]]));
 Object.assign(collections,{
  warehouses:[{_id:'w',name:'Synthetic warehouse',isSalesDefault:true}],
  paymentAccounts:[{id:'cash',code:'cash',name:'Synthetic cash',isActive:true,balance:1085,openingBalance:1000}],
  productCategories:[{id:adopted,name:'العطور'},{id:'custom',name:'Synthetic custom'},{id:decants,name:'التقسيمات'},{id:bottles,name:'زجاج التقسيمات'}],
  products:[
   {id:'plain',sku:'1',name:'Synthetic ordinary',categoryId:null,stocks:{w:3},openingCost:10,lastPurchaseCost:10},
   {id:'archived',sku:'2',name:'Synthetic archived',perfumeForm:'full',categoryId:'',isArchived:true,stocks:{w:0},openingCost:10},
   {id:'custom-full',sku:'3',name:'Synthetic custom perfume',perfumeForm:'full',categoryId:'custom',stocks:{w:4},openingCost:20,lastPurchaseCost:20},
   {id:'partial-custom-source',sku:'4',name:'Synthetic partial',perfumeForm:'partial',parentProductId:'custom-full',categoryId:null,partialVolumeMl:5,pieceCost:5,stocks:{w:1}},
   {id:'partial-orphan',sku:'5',name:'Synthetic old partial',perfumeForm:'partial',parentProductId:'absent-historic-parent',categoryId:null,isArchived:true,pieceCost:0,stocks:{w:0}},
   {id:'liquid',sku:'6',name:'Synthetic liquid',perfumeForm:'decant',categoryId:decants,perfumeStockUnit:'ml',stocks:{w:30},perfumeLots:[]},
   {id:'glass',sku:'7',name:'Synthetic glass',perfumeForm:'bottle',categoryId:bottles,stocks:{w:2},openingCost:2,lastPurchaseCost:2},
   {id:'default-full',sku:'8',name:'Synthetic classified perfume',perfumeForm:'full',categoryId:adopted,stocks:{w:1},openingCost:10},
  ],
  documents:[{id:'old-sale',number:'SAL-OLD',kind:'sale',status:'posted',sequence:1,occurredAt:'2026-01-01T12:00:00Z',businessDate:'2026-01-01',dailySequence:1,warehouseId:'w',paymentMethod:'cash',partyId:null,total:85,paidTotal:85,dueTotal:0,cashAmount:85,lines:[
   {id:'old-line-1',productId:'plain',description:'Original stored name',quantity:2,unitPrice:20,lineTotal:40,costAtSale:10,grossProfit:20},
   {id:'old-line-2',productId:'custom-full',description:'Original custom name',quantity:1,unitPrice:30,lineTotal:30,costAtSale:20,grossProfit:10},
   {id:'old-line-3',productId:'partial-custom-source',description:'Original partial name',quantity:1,unitPrice:15,lineTotal:15,costAtSale:5,grossProfit:10},
  ]}],
  stockMovements:[{id:'old-stock',documentId:'old-sale',documentNumber:'SAL-OLD',productId:'plain',warehouseId:'w',type:'sale',quantityDelta:-2,balanceBefore:5,balanceAfter:3,occurredAt:'2026-01-01T12:00:00Z'}],
  financialMovements:[{id:'old-cash',documentId:'old-sale',documentNumber:'SAL-OLD',type:'sale',direction:'in',amount:85,delta:85,paymentMethod:'cash',status:'posted',balanceBefore:1000,balanceAfter:1085,occurredAt:'2026-01-01T12:00:00Z'}],
 });
 return{format:'conta-backup',schemaVersion:1,createdAt:'2026-01-02T00:00:00Z',appVersion:'historical',encoding:'json-v2',collections,counts:Object.fromEntries(BACKUP_COLLECTIONS.map(name=>[name,collections[name].length]))};
}
async function fixture(t){const h=await sqliteHarness();t.after(()=>h.close());await h.reset();return h;}
async function insertBackup(db,backup){for(const name of BACKUP_COLLECTIONS)if(backup.collections[name]?.length)await db.collection(name).insertMany(backup.collections[name]);}
const snapshot=db=>Promise.all(BACKUP_COLLECTIONS.map(name=>db.collection(name).find().sort({id:1,_id:1}).toArray()));
const operational=db=>Promise.all(['documents','stockMovements','financialMovements','paymentAccounts'].map(name=>db.collection(name).find().sort({id:1}).toArray()));
const withoutClassification=products=>products.map(product=>{const copy={...product};delete copy.categoryId;return copy;}).sort((a,b)=>a.id.localeCompare(b.id));
const report=(db,type='sales',categoryId)=>buildReport(db,parseReportFilters(new URL(`http://local/api/reports?type=${type}&allTime=true&unpaged=true${categoryId?`&categoryId=${encodeURIComponent(categoryId)}`:''}`)));
const designation=db=>db.collection('appSettings').findOne({_id:'perfume-fragrance-category'});

test('native restore normalizes normal/archive/partial products while preserving custom and locked classes, accounting and unfiltered reports',async t=>{
 const {db}=await fixture(t),old=fixtureBackup();await insertBackup(db,old);
 const beforeProducts=await db.collection('products').find().toArray(),beforeOperations=await operational(db),beforeSales=await report(db),beforeOverview=await report(db,'overview'),beforeDefault=await report(db,'sales',adopted),beforeCustom=await report(db,'sales','custom');
 const backup=parseAndValidateBackup(stringifyBackup(await createNativeBackup(db))),unmodified=structuredClone(backup);
 await db.transaction(session=>restoreNativeBackup(db,backup,session));
 assert.deepEqual(backup,unmodified,'compatibility normalization must not rewrite the caller backup object');
 const products=await db.collection('products').find().toArray(),byId=new Map(products.map(product=>[product.id,product]));
 for(const id of ['plain','archived','partial-orphan','default-full'])assert.equal(byId.get(id).categoryId,adopted);
 assert.equal(byId.get('custom-full').categoryId,'custom');assert.equal(byId.get('partial-custom-source').categoryId,'custom');assert.equal(byId.get('liquid').categoryId,decants);assert.equal(byId.get('glass').categoryId,bottles);
 assert.equal((await designation(db)).categoryId,adopted);assert.equal((await db.collection('productCategories').findOne({id:adopted})).name,'العطور');
 assert.deepEqual(withoutClassification(products),withoutClassification(beforeProducts));assert.deepEqual(await operational(db),beforeOperations);
 assert.deepEqual((await report(db)).summary,beforeSales.summary);assert.deepEqual((await report(db,'overview')).summary,beforeOverview.summary);
 assert.equal(beforeDefault.summary.netSales,0);assert.equal((await report(db,'sales',adopted)).summary.netSales,40);
 assert.equal(beforeCustom.summary.netSales,30);assert.equal((await report(db,'sales','custom')).summary.netSales,45);
});

test('pre-category backup remains accepted and restored uncategorized products receive the default rather than dangling or missing categories',async t=>{
 const {db}=await fixture(t),old=fixtureBackup();old.collections.products=old.collections.products.filter(product=>!['liquid','glass'].includes(product.id));
 for(const product of old.collections.products)product.categoryId=null;delete old.collections.productCategories;delete old.counts.productCategories;old.collections.appSettings=[];
 const parsed=parseAndValidateBackup(JSON.stringify(old));assert.deepEqual(parsed.collections.productCategories,[]);
 await db.transaction(session=>restoreNativeBackup(db,parsed,session));const defaultId=(await designation(db)).categoryId;assert.equal(defaultId,canonical);
 for(const product of await db.collection('products').find().toArray())assert.equal(product.categoryId,defaultId);
 const exported=await createNativeBackup(db);assert.doesNotThrow(()=>parseAndValidateBackup(stringifyBackup(exported)));
});

test('native backup carries the trusted adopted designation and renamed default through restore and immediate re-export',async t=>{
 const {db}=await fixture(t);await insertBackup(db,fixtureBackup());await db.transaction(session=>ensurePerfumeSystemCategories(db,session));
 await db.collection('productCategories').updateOne({id:adopted},{$set:{name:'عطور المتجر'}});const backup=parseAndValidateBackup(stringifyBackup(await createNativeBackup(db))),before=await snapshot(db);
 await db.transaction(session=>restoreNativeBackup(db,backup,session));assert.equal((await designation(db)).categoryId,adopted);assert.equal((await db.collection('productCategories').findOne({id:adopted})).name,'عطور المتجر');
 const exported=parseAndValidateBackup(stringifyBackup(await createNativeBackup(db)));assert.equal(exported.collections.appSettings.find(setting=>setting._id==='perfume-fragrance-category').categoryId,adopted);
 assert.equal(exported.collections.productCategories.filter(category=>category.systemKind==='perfume-fragrances').length,1);const after=await snapshot(db);for(const [index,name]of BACKUP_COLLECTIONS.entries())if(name!=='counters')assert.deepEqual(after[index],before[index],name);
});

test('dangling category references reject before any restore mutation instead of being silently reassigned',async t=>{
 const {db}=await fixture(t);await db.collection('products').insertOne({id:'target-marker',sku:'99',name:'Target marker',stocks:{}});const before=await snapshot(db),bad=fixtureBackup();bad.collections.products[0].categoryId='not-in-this-backup';
 assert.throws(()=>parseAndValidateBackup(stringifyBackup(bad)),/فئة غير موجودة/);
 await assert.rejects(db.transaction(session=>restoreNativeBackup(db,bad,session)),/فئة غير موجودة/);assert.deepEqual(await snapshot(db),before);
});

test('failed category normalization rolls back the entire native restore replacement',async t=>{
 const {db}=await fixture(t);await db.collection('products').insertOne({id:'target-marker',sku:'99',name:'Target marker',stocks:{}});const before=await snapshot(db);
 db.native.exec(`CREATE TRIGGER fail_fragrance_restore BEFORE UPDATE ON products WHEN json_extract(NEW.data_json,'$.id')='plain' AND json_extract(NEW.data_json,'$.categoryId')='existing-fragrances' BEGIN SELECT RAISE(ABORT,'synthetic normalization failure'); END`);
 await assert.rejects(db.transaction(session=>restoreNativeBackup(db,fixtureBackup(),session)),/synthetic normalization failure/);assert.deepEqual(await snapshot(db),before);
});

async function legacyBytes(){const SQL=await initSqlJs(),sqlite=new SQL.Database();sqlite.run("CREATE TABLE itemsTB(id INTEGER,title TEXT,code TEXT,priceUnit REAL); INSERT INTO itemsTB VALUES(1,'Imported matched','MATCHED',90),(2,'Imported new','NEW',25),(3,'Imported old','OLD',30)");const bytes=sqlite.export();sqlite.close();return bytes;}
async function importTarget(db){await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});await db.collection('productCategories').insertMany([{id:adopted,name:'العطور'},{id:'custom',name:'Synthetic custom'}]);await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',isActive:true,balance:1234});await db.collection('products').insertMany([{id:'matched',sku:'70',name:'Keep existing custom',barcode:'MATCHED',categoryId:'custom',perfumeForm:'full',stocks:{w:7},pieceCost:50},{id:'old',sku:'71',name:'Keep existing uncategorized',barcode:'OLD',categoryId:null,isArchived:true,stocks:{w:0}}]);}

test('legacy product phase assigns new and old unassigned normals atomically, preserves matched custom data and is retry safe',async t=>{
 const {db}=await fixture(t);await importTarget(db);const bytes=await legacyBytes(),beforeOperations=await operational(db),matched=await db.collection('products').findOne({id:'matched'});
 const result=await executeLegacyImportPhase(db,bytes,'products');assert.equal(result.created,1);assert.equal(result.existing,2);
 assert.deepEqual(await db.collection('products').findOne({id:'matched'}),matched);assert.equal((await db.collection('products').findOne({id:'old'})).categoryId,adopted);const imported=await db.collection('products').findOne({barcode:'NEW'});assert.equal(imported.categoryId,adopted);assert.equal(imported.perfumeForm,undefined);assert.deepEqual(imported.stocks,{});
 const after=await db.collection('products').find().sort({id:1}).toArray();await executeLegacyImportPhase(db,bytes,'products');assert.deepEqual(await db.collection('products').find().sort({id:1}).toArray(),after);assert.deepEqual(await operational(db),beforeOperations);
});

test('legacy category failure rolls back product phase inserts and metadata, while finalize covers paused old runs',async t=>{
 const {db}=await fixture(t);await importTarget(db);const bytes=await legacyBytes(),before=await snapshot(db);
 db.native.exec(`CREATE TRIGGER fail_fragrance_import BEFORE UPDATE ON products WHEN json_extract(NEW.data_json,'$.categoryId')='existing-fragrances' BEGIN SELECT RAISE(ABORT,'synthetic import category failure'); END`);
 await assert.rejects(executeLegacyImportPhase(db,bytes,'products'),/synthetic import category failure/);assert.deepEqual(await snapshot(db),before);db.native.exec('DROP TRIGGER fail_fragrance_import');
 const operations=await operational(db);await executeLegacyImportPhase(db,bytes,'finalize');assert.equal((await db.collection('products').findOne({id:'old'})).categoryId,adopted);assert.equal((await db.collection('products').findOne({id:'matched'})).categoryId,'custom');assert.deepEqual(await operational(db),operations);
});
