import assert from 'node:assert/strict';
import test from 'node:test';
import {execute} from '../app/api/command/route.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {createNativeBackup,stringifyBackup,parseAndValidateBackup,restoreNativeBackup} from '../lib/backup.ts';
import {ensureDatabaseSchema} from '../lib/sqlite.ts';
import {purchaseLineFor,suggestedPurchasePrice} from '../app/purchase-draft.ts';
import {sqliteHarness} from './sqlite-harness.mjs';

const command=(h,body)=>h.db.transaction(s=>execute(h.db,s,body));
const filter=(extra={})=>({...parseReportFilters(new URL('http://local/api/reports?type=expenses&allTime=true')), ...extra});
async function fixture(t){const h=await sqliteHarness();t.after(()=>h.close());const cash=await h.db.collection('paymentAccounts').findOne({code:'cash'});await h.db.collection('paymentAccounts').updateOne({id:cash.id},{$set:{balance:10000}});return{h,cash:cash.id,post:(extra={})=>command(h,{type:'expense.post',title:'نقل بضاعة',amount:100,occurredAt:'2026-10-24',paymentMethod:cash.id,...extra})}}

test('purchase suggestion matches a recorded effective cost and preserves explicit zero',()=>{
  const p={id:'p',piecePrice:90,lastPurchaseCost:75,pieceCost:0};
  assert.equal(suggestedPurchasePrice(p),75);assert.equal(purchaseLineFor(p).unitPrice,'75');
  assert.equal(purchaseLineFor({...p,lastPurchaseCost:0,pieceCost:100}).unitPrice,'0');
  assert.equal(purchaseLineFor({...p,lastPurchaseCost:null,pieceCost:42}).unitPrice,'42');
  assert.equal(purchaseLineFor({...p,lastPurchaseCost:null,pieceCost:null}).unitPrice,'0');
});
test('expense categories reject normalized duplicates and invalid names without posting money',async t=>{
  const {h,cash}=await fixture(t);
  const id=await command(h,{type:'expense-category.create',name:'  Shop   Rent  '});
  assert.equal((await h.db.collection('expenseCategories').findOne({id})).name,'Shop Rent');
  for(const name of ['shop rent','Ｓｈｏｐ Rent'])await assert.rejects(command(h,{type:'expense-category.create',name}),/موجودة بالفعل/);
  for(const name of ['', ' '.repeat(5),'x'.repeat(81)])await assert.rejects(command(h,{type:'expense-category.create',name}),/اسم فئة/);
  assert.equal(await h.db.collection('documents').countDocuments(),0);assert.equal(await h.db.collection('financialMovements').countDocuments(),0);
  assert.equal((await h.db.collection('paymentAccounts').findOne({id:cash})).balance,10000);
});
test('expense category is authoritative, optional and distinct from product categories',async t=>{
  const {h,post,cash}=await fixture(t),category=await command(h,{type:'expense-category.create',name:'مواصلات'});
  const id=await post({expenseCategoryId:category,expenseCategoryName:'forged'}),d=await h.db.collection('documents').findOne({id});
  assert.equal(d.expenseCategoryId,category);assert.equal(d.expenseCategoryName,'مواصلات');assert.equal(d.total,100);
  assert.equal((await h.db.collection('paymentAccounts').findOne({id:cash})).balance,9900);
  await h.db.collection('productCategories').insertOne({id:'product-only',name:'منتجات'});
  for(const expenseCategoryId of ['missing','product-only',123])await assert.rejects(post({expenseCategoryId}),/فئة المصروف/);
  assert.equal(await h.db.collection('documents').countDocuments(),1);
  const uncategorized=await post();assert.equal((await h.db.collection('documents').findOne({id:uncategorized})).expenseCategoryId,null);
});
test('reclassification, legacy-client edit, clearing and void keep cash and category reports balanced',async t=>{
  const {h,post,cash}=await fixture(t),a=await command(h,{type:'expense-category.create',name:'نقل'}),b=await command(h,{type:'expense-category.create',name:'إيجار'});
  const id=await post({expenseCategoryId:a});
  const update=(extra={})=>command(h,{type:'expense.update',documentId:id,title:'نقل',amount:100,occurredAt:'2026-10-24',paymentMethod:cash,...extra});
  await update({expenseCategoryId:b});assert.equal((await buildReport(h.db,filter({expenseCategoryId:a}))).summary.total,0);assert.equal((await buildReport(h.db,filter({expenseCategoryId:b}))).summary.total,100);
  await update();assert.equal((await h.db.collection('documents').findOne({id})).expenseCategoryId,b);
  await assert.rejects(update({expenseCategoryId:'missing'}),/غير موجودة/);assert.equal((await h.db.collection('paymentAccounts').findOne({id:cash})).balance,9900);
  await update({expenseCategoryId:''});assert.equal((await buildReport(h.db,filter({expenseCategoryId:'__uncategorized'}))).summary.total,100);
  await update({expenseCategoryId:a,amount:150});assert.equal((await buildReport(h.db,filter({expenseCategoryId:a}))).summary.total,150);
  await command(h,{type:'expense.void',documentId:id});assert.equal((await buildReport(h.db,filter())).summary.total,0);assert.equal((await h.db.collection('paymentAccounts').findOne({id:cash})).balance,10000);
  await assert.rejects(command(h,{type:'expense.void',documentId:id}),/ملغاة/);
});
test('category totals obey date, payment, paging and unpaged export with old uncategorized records',async t=>{
  const {h,post}=await fixture(t),category=await command(h,{type:'expense-category.create',name:'أجور'});
  for(let i=0;i<3;i++)await post({expenseCategoryId:category,amount:10*(i+1)});
  await post({expenseCategoryId:category,occurredAt:'2026-10-23',amount:40});
  const old=await post({amount:50});await h.db.collection('documents').updateOne({id:old},{$unset:{expenseCategoryId:'',expenseCategoryName:''}});
  const f=filter({expenseCategoryId:category,allTime:false,from:'2026-10-24',to:'2026-10-24',pageSize:1});
  const r=await buildReport(h.db,f);assert.equal(r.summary.total,60);assert.equal(r.summary.count,3);assert.equal(r.rows.length,1);assert.equal(r.meta.totalRows,3);assert.equal(r.rows[0].expenseCategory,'أجور');
  assert.equal((await buildReport(h.db,{...f,unpaged:true})).rows.length,3);
  assert.equal((await buildReport(h.db,{...f,paymentAccountId:'missing'})).summary.total,0);
  assert.equal((await buildReport(h.db,filter({expenseCategoryId:'__uncategorized'}))).summary.total,50);
  assert.equal((await buildReport(h.db,filter())).summary.total,150);
  assert.equal(parseReportFilters(new URL('http://local?type=expenses&allTime=true&expenseCategoryId=x')).expenseCategoryId,'x');
  assert.equal(parseReportFilters(new URL('http://local?type=profit&allTime=true&expenseCategoryId=x')).expenseCategoryId,undefined);
});
test('native backup round-trips category definitions and classifications and rejects dangling references',async t=>{
  const {h,post}=await fixture(t),category=await command(h,{type:'expense-category.create',name:'صيانة'});await post({expenseCategoryId:category});
  const backup=parseAndValidateBackup(stringifyBackup(await createNativeBackup(h.db)));
  assert.equal(backup.collections.expenseCategories.length,1);
  await command(h,{type:'expense-category.create',name:'temporary'});await h.db.transaction(s=>restoreNativeBackup(h.db,backup,s));
  assert.equal(await h.db.collection('expenseCategories').countDocuments(),1);assert.equal((await buildReport(h.db,filter({expenseCategoryId:category}))).summary.total,100);
  const broken=structuredClone(backup);broken.collections.expenseCategories=[];assert.throws(()=>parseAndValidateBackup(JSON.stringify(broken)),/مصروف يشير إلى فئة/);
  const invalid=structuredClone(backup);invalid.collections.expenseCategories={};assert.throws(()=>parseAndValidateBackup(JSON.stringify(invalid)),/collection مفقود/);
});
test('older backups without expense categories still restore without assigning historical expenses',async t=>{
  const {h,post}=await fixture(t);await post();const backup=await createNativeBackup(h.db);delete backup.collections.expenseCategories;delete backup.counts.expenseCategories;
  const old=parseAndValidateBackup(JSON.stringify(backup));assert.deepEqual(old.collections.expenseCategories,[]);
  await h.db.transaction(s=>restoreNativeBackup(h.db,old,s));assert.equal((await buildReport(h.db,filter({expenseCategoryId:'__uncategorized'}))).summary.total,100);
});
test('schema v8 adds category storage to an existing v7 database without changing old documents',async t=>{
  const {h,post}=await fixture(t);await post();const before=await h.db.collection('documents').find().toArray();
  h.db.native.exec('DROP TABLE expense_categories; DELETE FROM schema_migrations WHERE version=8;');
  ensureDatabaseSchema(h.db);assert.equal(await h.db.collection('expenseCategories').countDocuments(),0);assert.deepEqual(await h.db.collection('documents').find().toArray(),before);
  ensureDatabaseSchema(h.db);assert.equal(h.db.native.prepare('SELECT max(version) v FROM schema_migrations').get().v,8);
});
