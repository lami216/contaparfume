import assert from 'node:assert/strict';
import test,{before,beforeEach,after} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

let directory,sqlite,db,POST,buildReport,parseReportFilters;
const environment=new Map(),origin='http://127.0.0.1:3233';
const post=async(body,key=randomUUID())=>{const response=await POST(new Request(origin+'/api/command',{method:'POST',headers:{Origin:origin,Host:'127.0.0.1:3233','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()};};
const ok=async body=>{const result=await post(body);assert.equal(result.status,200,JSON.stringify(result));return result.body.id;};
const document=id=>db.collection('documents').findOne({id}),product=id=>db.collection('products').findOne({id});
const cash=async()=>(await db.collection('paymentAccounts').findOne({id:'cash'})).balance;
const state=()=>Promise.all(['documents','products','parties','paymentAccounts','stockMovements','financialMovements','auditEvents','commandReceipts','counters'].map(name=>db.collection(name).find().toArray()));
const report=type=>buildReport(db,parseReportFilters(new URL(origin+'/api/reports?type='+type+'&allTime=true&unpaged=true')));
const body=(kind,lines,extra={})=>({type:kind+'.post',warehouseId:'w',paymentMethod:'cash',lines,...extra});

before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'alkarna-invoice-line-amount-'));
 for(const [key,value]of Object.entries({NODE_ENV:'test',ALKARNA_DESKTOP:'1',ALKARNA_USER_DATA:join(directory,'profile'),ALKARNA_DATABASE_PATH:join(directory,'database.sqlite'),ALKARNA_LICENSE_STATE_PATH:join(directory,'license-state.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1',ALKARNA_TEST_LICENSE_BYPASS:'1'})){environment.set(key,process.env[key]);process.env[key]=value;}
 sqlite=await import('../lib/sqlite.ts');sqlite.closeDatabase();db=sqlite.initializeDatabase();({POST}=await import('../app/api/command/route.ts'));({buildReport,parseReportFilters}=await import('../lib/reports.ts'));
});
after(async()=>{sqlite?.closeDatabase();for(const[key,value]of environment){if(value===undefined)delete process.env[key];else process.env[key]=value;}if(directory)await rm(directory,{recursive:true,force:true});});
beforeEach(async()=>{
 await db.dropDatabase();await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',balance:10000,openingBalance:10000,isActive:true});
 await db.collection('products').insertMany(['p','other'].map((id,index)=>({id,sku:String(index+1),name:'Synthetic '+id,perfumeForm:'full',stocks:{w:20},openingCost:10,lastPurchaseCost:10,pieceCost:10,piecePrice:150})));
});

test('actual sale POST/edit/void preserves exact agreed revenue, cost and stock; the same receipt never posts twice',async()=>{
 const key=randomUUID(),sale=body('sale',[{productId:'p',quantity:3,piecePrice:133.5,lineTotal:400.5}],{paidAmount:400.5});
 const posted=await post(sale,key);assert.equal(posted.status,200,JSON.stringify(posted));const id=posted.body.id;let saved=await document(id);
 assert.equal(saved.total,400.5);assert.equal(saved.lines[0].lineTotalMode,'exact');assert.equal(saved.lines[0].costAtSale,10);assert.equal(saved.lines[0].grossProfit,370.5);assert.equal(await cash(),10400.5);assert.equal((await product('p')).stocks.w,17);
 const beforeRetry=await state();assert.deepEqual(await post(sale,key),posted);assert.deepEqual(await state(),beforeRetry);
 await ok({type:'sale.update',documentId:id,warehouseId:'w',paymentMethod:'cash',lines:[{productId:'p',quantity:4,piecePrice:133.5,lineTotal:534}]});saved=await document(id);
 assert.equal(saved.total,534);assert.equal(saved.lines[0].costAtSale,10);assert.equal(saved.lines[0].grossProfit,494);assert.equal((await product('p')).stocks.w,16);assert.equal(await cash(),10534);
 const sales=await report('sales');assert.equal(sales.summary.netSales,534);assert.equal(sales.summary.cost,40);assert.equal(sales.summary.profit,494);
 await ok({type:'sale.void',documentId:id});assert.equal((await product('p')).stocks.w,20);assert.equal(await cash(),10000);assert.equal((await report('sales')).summary.netSales,0);
});

test('old rounded native invoices remain unchanged on header edits and a client mode alone cannot enable new arithmetic',async()=>{
 for(const kind of ['purchase','sale']){
  const price=kind==='sale'?'piecePrice':'unitPrice',id=await ok(body(kind,[{productId:'p',quantity:3,[price]:100.2,lineTotalMode:'exact'}]));
  const before=await document(id),stock=(await product('p')).stocks.w,balance=await cash();assert.equal(before.total,301);assert.equal(before.lines[0].lineTotalMode,undefined);
  const partyId=await ok({type:'party.create',partyType:kind==='sale'?'customer':'supplier',name:'Synthetic '+kind});
  await ok({type:kind+'.update',documentId:id,warehouseId:'w',partyId,paymentMethod:'cash',lines:[{productId:'p',quantity:3,[price]:100.2}]});
  const after=await document(id);assert.equal(after.total,301);assert.equal(after.lines[0].lineTotalMode,undefined);assert.equal(after.lines[0].costAtSale,before.lines[0].costAtSale);assert.equal((await product('p')).stocks.w,stock);assert.equal(await cash(),balance);
 }
});

test('exact purchase cost is derived from the unit, while subsequent purchase edits never recost an already sold line',async()=>{
 const id=await ok(body('purchase',[{productId:'p',quantity:3,unitPrice:133.5,lineTotal:400.5}]));
 assert.equal((await product('p')).lastPurchaseCost,133.5);assert.equal((await product('p')).stocks.w,23);assert.equal(await cash(),9599.5);
 const saleId=await ok(body('sale',[{productId:'p',quantity:1,piecePrice:200}])),sold=await document(saleId);assert.equal(sold.lines[0].costAtSale,133.5);
 const stock=(await product('p')).stocks.w;
 await ok({type:'purchase.update',documentId:id,warehouseId:'w',paymentMethod:'cash',lines:[{productId:'p',quantity:3,unitPrice:200.125,lineTotal:600.375}]});
 assert.equal((await document(id)).total,600.375);assert.equal((await product('p')).lastPurchaseCost,200.125);assert.equal((await product('p')).stocks.w,stock);assert.deepEqual((await document(saleId)).lines,sold.lines);
 // Even an older client that omits the new field cannot silently round a saved exact header edit.
 await ok({type:'purchase.update',documentId:id,warehouseId:'w',paymentMethod:'cash',lines:[{productId:'p',quantity:3,unitPrice:200.125}]});assert.equal((await document(id)).total,600.375);assert.equal((await document(id)).lines[0].lineTotalMode,'exact');
});

test('exact decimal request, saved invoice and cash agree; existing report aggregation differs by at most IEEE precision',async()=>{
 const lines=[{productId:'p',quantity:1,piecePrice:0.1,lineTotal:0.1},{productId:'other',quantity:1,piecePrice:0.2,lineTotal:0.2}];
 const id=await ok(body('sale',lines,{paidAmount:0.3})),saved=await document(id);assert.equal(saved.total,0.3);assert.equal(saved.paidTotal,0.3);
 const movement=await db.collection('financialMovements').findOne({documentId:id,isReversal:{$ne:true}});assert.equal(movement.amount,0.3);
 // Reports retain their existing per-line aggregation; do not broaden this UI
 // change into a rewrite of historical revenue/cost arithmetic.
 assert(Math.abs((await report('sales')).summary.netSales-0.3)<=Number.EPSILON*4);
});

test('exact note invoices change the proper party balance and void without moving cash',async()=>{
 const customer=await ok({type:'party.create',partyType:'customer',name:'Synthetic customer'}),supplier=await ok({type:'party.create',partyType:'supplier',name:'Synthetic supplier'});
 for(const [kind,partyId,price]of [['sale',customer,'piecePrice'],['purchase',supplier,'unitPrice']]){
  const id=await ok(body(kind,[{productId:'p',quantity:3,[price]:133.5,lineTotal:400.5}],{partyId,paymentMethod:'note'}));
  const party=await db.collection('parties').findOne({id:partyId});assert.equal(kind==='sale'?party.receivable:party.payable,400.5);assert.equal(await cash(),10000);
  await ok({type:kind+'.void',documentId:id});const cleared=await db.collection('parties').findOne({id:partyId});assert.equal(cleared.receivable,0);assert.equal(cleared.payable,0);assert.equal(await cash(),10000);
 }
});

test('invalid explicit totals fail atomically and the failed idempotency key can be retried with a corrected amount',async()=>{
 const stable=await state();
 for(const value of [null,'','.',true,{},[],0,-1,'Infinity',Number.MAX_SAFE_INTEGER+1,299.99]){
  const rejected=await post(body('sale',[{productId:'p',quantity:3,piecePrice:100,lineTotal:value}]));assert.equal(rejected.status,400,JSON.stringify(rejected));assert.deepEqual(await state(),stable);
 }
 const key=randomUUID(),invalid=body('purchase',[{productId:'p',quantity:3,unitPrice:100,lineTotal:301}]);assert.equal((await post(invalid,key)).status,400);assert.equal(await db.collection('commandReceipts').findOne({_id:key}),null);
 assert.equal((await post(body('purchase',[{productId:'p',quantity:3,unitPrice:100,lineTotal:300}]),key)).status,200);
});

test('a storage failure rolls back stock, exact revenue and receipt, then a same-key retry succeeds',async()=>{
 const key=randomUUID(),request=body('sale',[{productId:'p',quantity:3,piecePrice:133.5,lineTotal:400.5}]),before=await state();
 db.native.exec("CREATE TRIGGER invoice_amount_failure BEFORE INSERT ON financial_movements BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INVOICE_AMOUNT_FAILURE'); END");
 try{assert.equal((await post(request,key)).status,500);assert.deepEqual(await state(),before);}finally{db.native.exec('DROP TRIGGER invoice_amount_failure');}
 const saved=await post(request,key);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal((await document(saved.body.id)).total,400.5);assert.equal((await product('p')).stocks.w,17);
});
