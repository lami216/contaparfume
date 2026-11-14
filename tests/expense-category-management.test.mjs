import assert from 'node:assert/strict';
import test, {after,before,beforeEach} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

let directory,sqlite,db,execute,POST,bootstrap,auth,backup,categories;
const origin='http://127.0.0.1:3219';
const savedEnvironment=new Map();
const protectedCollections=['documents','products','stockMovements','financialMovements','paymentAccounts','parties'];
const rows=name=>db.collection(name).find().toArray();
const businessState=()=>Promise.all(protectedCollections.map(rows));
const fullState=()=>Promise.all([...protectedCollections,'expenseCategories','auditEvents','commandReceipts'].map(rows));
const command=body=>db.transaction(session=>execute(db,session,body));
const expense=(extra={})=>command({type:'expense.post',title:'Synthetic expense',amount:100,occurredAt:'2026-11-14',paymentMethod:'cash',...extra});
const post=async(body,user,key=randomUUID())=>{
  const response=await POST(new Request(origin+'/api/command',{method:'POST',headers:{Origin:origin,Host:'127.0.0.1:3219','content-type':'application/json','Idempotency-Key':key,...(user?{Cookie:`conta_session=${auth.createSession({principalType:'user',userId:user})}`}:{})},body:JSON.stringify(body)}));
  return{status:response.status,body:await response.json()};
};

before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'alkarna-expense-category-management-'));
  const environment={NODE_ENV:'test',ALKARNA_DESKTOP:'1',ALKARNA_USER_DATA:join(directory,'profile'),ALKARNA_DATABASE_PATH:join(directory,'database.sqlite'),ALKARNA_LICENSE_STATE_PATH:join(directory,'license-state.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1',ALKARNA_TEST_LICENSE_BYPASS:'1'};
  for(const [key,value] of Object.entries(environment)){savedEnvironment.set(key,process.env[key]);process.env[key]=value;}
  sqlite=await import('../lib/sqlite.ts');sqlite.closeDatabase();db=sqlite.initializeDatabase();
  ({execute,POST}=await import('../app/api/command/route.ts'));
  bootstrap=(await import('../app/api/bootstrap/route.ts')).GET;
  auth=await import('../lib/auth.ts');backup=await import('../lib/backup.ts');categories=await import('../lib/expense-categories.ts');
});
after(async()=>{
  sqlite?.closeDatabase();
  for(const [key,value] of savedEnvironment){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if(directory)await rm(directory,{recursive:true,force:true});
});
beforeEach(async()=>{
  await db.dropDatabase();
  await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});
  await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,balance:10000,openingBalance:10000});
});

test('old category defaults and old-client creation are recurring; explicit kind is strictly validated',async()=>{
  for(const category of [undefined,null,{}, {kind:undefined}])assert.equal(categories.expenseCategoryKind(category),'recurring');
  assert.equal(categories.expenseCategoryKind({kind:'nonrecurring'}),'nonrecurring');
  const id=await command({type:'expense-category.create',name:'  Shop   Rent  '});
  const stored=await db.collection('expenseCategories').findOne({id});
  assert.equal(stored.name,'Shop Rent');assert.equal(stored.kind,'recurring');assert.equal(stored.revision,0);assert.equal(stored.isArchived,false);
  const before=await fullState();
  for(const kind of [null,'once','',true,0,[],{}])await assert.rejects(command({type:'expense-category.create',name:'Invalid kind',kind}),/نوع فئة المصروف/);
  assert.deepEqual(await fullState(),before);
  const nonrecurring=await command({type:'expense-category.create',name:'One off',kind:'nonrecurring'});
  assert.equal((await db.collection('expenseCategories').findOne({id:nonrecurring})).kind,'nonrecurring');
});

test('category rename and kind edit preserve every old invoice and all money, dates and stock while journaling metadata',async()=>{
  const id=await command({type:'expense-category.create',name:'Original rent'}),documentId=await expense({expenseCategoryId:id});
  const before=await businessState(),original=await db.collection('expenseCategories').findOne({id});
  assert.equal(await command({type:'expense-category.update',id,name:'Renamed rent',kind:'nonrecurring',expectedRevision:0}),id);
  const revised=await db.collection('expenseCategories').findOne({id});
  assert.deepEqual(await businessState(),before);assert.equal(revised.kind,'nonrecurring');assert.equal(revised.revision,1);
  assert.equal((await db.collection('documents').findOne({id:documentId})).expenseCategoryName,'Original rent');
  const event=(await rows('auditEvents')).find(row=>row.action==='expense-category.update'&&row.before);
  assert.deepEqual(event.before,original);assert.deepEqual(event.after,revised);assert.equal(event.status,'committed');
  await command({type:'expense-category.update',id,name:'Renamed again',expectedRevision:1});
  assert.equal((await db.collection('expenseCategories').findOne({id})).kind,'nonrecurring');
  const stable=await fullState();
  await assert.rejects(command({type:'expense-category.update',id,name:'Stale',kind:'recurring',expectedRevision:0}),/تغيرت فئة المصروف/);
  await assert.rejects(command({type:'expense-category.delete',id,expectedRevision:0}),/تغيرت فئة المصروف/);
  for(const expectedRevision of [null,'2',true,-1,0.5])await assert.rejects(command({type:'expense-category.update',id,name:'Invalid revision',expectedRevision}),/إصدار فئة المصروف/);
  assert.deepEqual(await fullState(),stable);
});

test('used-category deletion preserves even voided history and reserves its normalized name',async()=>{
  const id=await command({type:'expense-category.create',name:'  Historical   Rent ',kind:'nonrecurring'}),documentId=await expense({expenseCategoryId:id});
  await command({type:'expense.void',documentId});
  const before=await businessState();
  assert.deepEqual(await command({type:'expense-category.delete',id,expectedRevision:0}),{id,disposition:'archived'});
  const category=await db.collection('expenseCategories').findOne({id});
  assert.equal(category.isArchived,true);assert.equal(category.kind,'nonrecurring');assert.equal(category.revision,1);assert.deepEqual(await businessState(),before);
  const stable=await fullState();
  await assert.rejects(command({type:'expense-category.create',name:'Ｈｉｓｔｏｒｉｃａｌ rent'}),/فئة مؤرشفة/);
  await assert.rejects(expense({expenseCategoryId:id}),/مؤرشفة/);
  assert.deepEqual(await fullState(),stable);
  assert.deepEqual(await command({type:'expense-category.delete',id,expectedRevision:1}),{id,disposition:'archived'});
  assert.deepEqual(await fullState(),stable,'Repeated archive has no second mutation or audit');
  await command({type:'expense-category.update',id,name:'Archived name corrected',kind:'recurring',expectedRevision:1});
  assert.equal((await db.collection('expenseCategories').findOne({id})).isArchived,true);
  assert.deepEqual(await businessState(),before);
});

test('an archived category can be retained only by its original expense, including after a category rename',async()=>{
  const id=await command({type:'expense-category.create',name:'Historic category'}),first=await expense({expenseCategoryId:id}),other=await expense();
  await command({type:'expense-category.delete',id});
  await command({type:'expense-category.update',id,name:'Renamed archived category',kind:'nonrecurring'});
  const edit={type:'expense.update',documentId:first,title:'Edited expense',amount:100,occurredAt:'2026-11-14',paymentMethod:'cash'};
  await command({...edit,expenseCategoryId:id});
  assert.equal((await db.collection('documents').findOne({id:first})).expenseCategoryName,'Historic category');
  await command({...edit,title:'Legacy-client note edit'});
  assert.equal((await db.collection('documents').findOne({id:first})).expenseCategoryId,id);
  const stable=await fullState();
  await assert.rejects(command({...edit,documentId:other,expenseCategoryId:id}),/مؤرشفة/);
  await assert.rejects(command({...edit,expenseCategoryId:'missing'}),/غير موجودة/);
  assert.deepEqual(await fullState(),stable);
  assert.equal((await db.collection('paymentAccounts').findOne({id:'cash'})).balance,9800);
});

test('unused deletion is physical and audited without financial effects; accepted legacy numeric references remain protected',async()=>{
  const id=await command({type:'expense-category.create',name:'Unused'}),before=await businessState();
  assert.deepEqual(await command({type:'expense-category.delete',id,expectedRevision:0}),{id,disposition:'deleted'});
  assert.equal(await db.collection('expenseCategories').findOne({id}),null);assert.deepEqual(await businessState(),before);
  const event=(await rows('auditEvents')).find(row=>row.action==='expense-category.delete'&&row.before);
  assert.equal(event.before.id,id);assert.equal(event.after,null);assert.equal(event.disposition,'deleted');
  assert.notEqual(await command({type:'expense-category.create',name:'Unused'}),id);
  await db.collection('expenseCategories').insertOne({id:'41',name:'Legacy numeric reference'});
  const documentId=await expense();await db.collection('documents').updateOne({id:documentId},{$set:{expenseCategoryId:41,expenseCategoryName:'Legacy numeric reference'}});
  const legacyBefore=await businessState();
  assert.deepEqual(await command({type:'expense-category.delete',id:'41'}),{id:'41',disposition:'archived'});
  assert.deepEqual(await businessState(),legacyBefore);
});

test('duplicate updates and invalid payloads are atomic and never change the destination or source category',async()=>{
  const a=await command({type:'expense-category.create',name:'Rent'}),b=await command({type:'expense-category.create',name:'Transport'}),before=await fullState();
  for(const body of [
    {type:'expense-category.update',id:b,name:'Ｒｅｎｔ'},
    ...['',' '.repeat(5),'x'.repeat(81),123].map(name=>({type:'expense-category.update',id:a,name})),
    ...[null,'once',true].map(kind=>({type:'expense-category.update',id:a,kind})),
    {type:'expense-category.update',id:'missing',name:'Missing'},
    {type:'expense-category.delete',id:'missing'},
  ])await assert.rejects(command(body));
  assert.deepEqual(await fullState(),before);
});

test('native backups preserve archived references, reject malformed new fields and retain old missing fields exactly',async()=>{
  const id=await command({type:'expense-category.create',name:'Backup category',kind:'nonrecurring'});await expense({expenseCategoryId:id});await command({type:'expense-category.delete',id});
  const current=backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(db)));
  const original=structuredClone(current.collections.expenseCategories),business=await businessState();
  await command({type:'expense-category.create',name:'Temporary'});
  await db.transaction(session=>backup.restoreNativeBackup(db,current,session));
  assert.deepEqual(await rows('expenseCategories'),original);assert.deepEqual(await businessState(),business);
  for(const [field,value] of [['kind',null],['kind','once'],['kind',0],['isArchived','true'],['isArchived',null],['revision',-1],['revision','1']]){
    const invalid=structuredClone(current);invalid.collections.expenseCategories[0][field]=value;
    assert.throws(()=>backup.parseAndValidateBackup(JSON.stringify(invalid)),/فئة المصروف/);
  }
  const missing=structuredClone(current);missing.collections.expenseCategories=[];
  assert.throws(()=>backup.parseAndValidateBackup(JSON.stringify(missing)),/مصروف يشير إلى فئة/);
  const old=structuredClone(current);
  for(const category of old.collections.expenseCategories){delete category.kind;delete category.isArchived;delete category.revision;}
  const parsed=backup.parseAndValidateBackup(JSON.stringify(old));
  assert.deepEqual(parsed.collections.expenseCategories,old.collections.expenseCategories);
  await db.transaction(session=>backup.restoreNativeBackup(db,parsed,session));
  const restored=await rows('expenseCategories');assert.deepEqual(restored,old.collections.expenseCategories);
  assert.equal(categories.expenseCategoryKind(restored[0]),'recurring');assert.deepEqual(await businessState(),business);
});

test('actual command permissions separate creation, editing and deletion, while bootstrap retains archived metadata',async()=>{
  for(const [id,permissions] of Object.entries({viewer:['expenses.view'],creator:['expenses.create'],editor:['expenses.edit'],deleter:['expenses.delete']}))await db.collection('users').insertOne({id,username:id,name:id,isActive:true,permissions});
  const create={type:'expense-category.create',name:'Permissions category',kind:'nonrecurring'};
  assert.equal((await post(create)).status,401);
  assert.equal((await post(create,'viewer')).status,403);
  const created=await post(create,'creator');assert.equal(created.status,200);const id=created.body.id;
  assert.equal((await post({type:'expense-category.update',id,name:'Denied'},'creator')).status,403);
  assert.equal((await post({type:'expense-category.delete',id},'editor')).status,403);
  assert.equal((await post({type:'expense-category.update',id,name:'Edited category',kind:'recurring',expectedRevision:0},'editor')).status,200);
  await expense({expenseCategoryId:id});
  const deleted=await post({type:'expense-category.delete',id,expectedRevision:1},'deleter');assert.equal(deleted.status,200);assert.equal(deleted.body.disposition,'archived');
  const response=await bootstrap(new Request(origin+'/api/bootstrap',{headers:{Cookie:`conta_session=${auth.createSession({principalType:'user',userId:'viewer'})}`}}));
  assert.equal(response.status,200);const exposed=(await response.json()).expenseCategories.find(row=>row.id===id);
  assert.equal(exposed.isArchived,true);assert.equal(exposed.kind,'recurring');assert.equal(exposed.name,'Edited category');
});

test('actual POST failures roll back category and audit changes, then the same key retries exactly once',async()=>{
  const used=await command({type:'expense-category.create',name:'Used rollback category'});await expense({expenseCategoryId:used});
  for(const body of [
    {type:'expense-category.create',name:'New rollback category',kind:'nonrecurring'},
    {type:'expense-category.update',id:used,name:'Renamed rollback category',kind:'nonrecurring',expectedRevision:0},
    {type:'expense-category.delete',id:used,expectedRevision:1},
  ]){
    const key=randomUUID(),before=await fullState();
    db.native.exec(`CREATE TRIGGER fail_category_audit BEFORE INSERT ON audit_events WHEN json_extract(NEW.data_json,'$.action')='${body.type}' AND (json_type(NEW.data_json,'$.before')='object' OR json_type(NEW.data_json,'$.after')='object') BEGIN SELECT RAISE(ABORT,'synthetic category journal failure'); END;`);
    const failed=await post(body,undefined,key);assert(failed.status>=400,JSON.stringify(failed));assert.deepEqual(await fullState(),before);
    assert.equal(await db.collection('commandReceipts').findOne({_id:key}),null);
    db.native.exec('DROP TRIGGER fail_category_audit');
    const retried=await post(body,undefined,key);assert.equal(retried.status,200,JSON.stringify(retried));
    const once=await fullState();assert.deepEqual(await post(body,undefined,key),retried);assert.deepEqual(await fullState(),once);
  }
});
