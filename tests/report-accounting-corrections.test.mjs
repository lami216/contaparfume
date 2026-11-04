import test from 'node:test';import assert from 'node:assert/strict';
import {sqliteHarness} from './sqlite-harness.mjs';
import {calculatePartyFinancialSummaries} from '../app/party-metrics.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {reportCostNumber,reportNetLines,latestReportCost} from '../lib/report-commerce.ts';

const line=(id,productId,quantity,price,cost)=>({id,productId,description:productId,quantity,unitPrice:price,lineTotal:quantity*price,...(cost===undefined?{}:{costAtSale:cost})});
const doc=(id,kind,date,lines,extra={})=>({id,number:'SYN-'+id,kind,status:'posted',occurredAt:date+'T12:00:00.000Z',total:lines.reduce((sum,line)=>sum+line.lineTotal,0),paidTotal:0,dueTotal:0,lines,...extra});
async function fixture(t){const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;await db.collection('productCategories').insertMany([{id:'cat-a',_id:'cat-a',name:'Synthetic category A'},{id:'cat-b',_id:'cat-b',name:'Synthetic category B'}]);await db.collection('products').insertMany([{id:'a',name:'Synthetic A',sku:'1',categoryId:'cat-a',stocks:{w:2},openingCost:80},{id:'b',name:'Synthetic B',sku:'2',categoryId:'cat-b',stocks:{w:3}}]);await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse'});return{db,reset:()=>h.reset(),report:(type='profit',extra={})=>buildReport(db,parseReportFilters(new URL('http://local/api/reports?'+new URLSearchParams({type,allTime:'true',unpaged:'true',...extra}))))};}
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);

test('cost parser rejects missing/malformed values while retaining legitimate zero and old decimal strings',()=>{
 for(const value of [undefined,null,'',' ',false,true,{},[],[1],-1,NaN,Infinity,'0x10','not-number'])assert.equal(reportCostNumber(value),null,String(value));
 for(const value of [0,'0',' 0 ',100,'100','1.25','1e2'])assert.equal(reportCostNumber(value),Number(value));
});

test('latest source is selected before validation and conflicting equal timestamp/sequence sources remain uncertain',()=>{
 const at='2026-08-10T12:00:00.000Z',rows=[{at:'2026-08-01',sequence:1,value:100},{at:'2026-08-02',sequence:2,value:null}];
 assert.deepEqual(latestReportCost(rows,at),{present:true,cost:null});assert.deepEqual(latestReportCost([...rows,{at:'2026-08-20',sequence:3,value:999}],at),{present:true,cost:null});
 assert.deepEqual(latestReportCost([{at:'2026-08-01',sequence:1,value:100},{at:'2026-08-01',sequence:1,value:200}],at),{present:true,cost:null});
 assert.deepEqual(latestReportCost([{at:'2026-08-01',sequence:1,value:100},{at:'2026-08-01',sequence:2,value:200}],at),{present:true,cost:200});
 assert.deepEqual(latestReportCost([{at:'2026-08-01',sequence:1,value:100},{at:'2026-08-01',sequence:1,value:100}],at),{present:true,cost:100});
});

test('unknown cost status propagates through every profit-bearing report and overview invoice/drilldown',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertOne(doc('sale','sale','2026-08-10',[line('s','a',1,150,null)]));
 for(const type of ['sales','profit','product-sales','overview']){const report=await f.report(type);assert.equal(report.summary.costKnown,false,type);assert.equal(report.summary.unknownRevenue,150,type);if(type==='overview'){assert.equal(report.invoices[0].costKnown,false);assert.equal(report.invoices[0].unknownRevenue,150);assert.equal(report.overviewDetails.salesProfit[0].costKnown,false);assert.equal(report.overviewDetails.salesProfit[0].unknownRevenue,150);}else{assert.equal(report.rows.find(row=>row.documentId==='sale'||row.productId==='a').costKnown,false);}}
});

test('explicit numeric zero snapshots stay known while malformed snapshots can only use a valid historical source',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertOne(doc('purchase','purchase','2026-08-01',[line('buy','a',10,100)]));
 for(const snapshot of [0,'0',null,'',false,{},[]]){await f.db.collection('documents').deleteMany({kind:'sale'});await f.db.collection('documents').insertOne(doc('sale','sale','2026-08-10',[line('s','a',1,150,snapshot)]));const report=await f.report();assert.equal(report.summary.cost,snapshot===0||snapshot==='0'?0:100);assert.equal(report.summary.costKnown,true);assert.equal(report.summary.unknownRevenue,0);}
});

test('an invalid latest prior purchase blocks older and opening fallback instead of inventing a confirmed price',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertMany([doc('opening','adjustment','2026-07-01',[line('o','a',2,80)],{number:'OPEN-1'}),doc('first','purchase','2026-08-01',[line('b1','a',1,100)]),doc('last','purchase','2026-08-05',[line('b2','a',1,0)]),doc('sale','sale','2026-08-10',[line('s','a',1,150)])]);
 for(const value of [null,'',false,{},[],0,-1]){const latest=await f.db.collection('documents').findOne({id:'last'});await f.db.collection('documents').updateOne({id:'last'},{$set:{lines:latest.lines.map(line=>({...line,unitPrice:value}))}});const report=await f.report();assert.equal(report.summary.costKnown,false,String(value));assert.equal(report.summary.unknownRevenue,150);assert.equal(report.summary.cost,0);}
});

test('native opening fallback and same-date sequence work without using future purchases',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertMany([doc('opening','adjustment','2026-08-01',[line('o','a',2,80)],{number:'OPEN-1'}),doc('sale','sale','2026-08-10',[line('s','a',1,150)]),doc('future','purchase','2026-08-20',[line('f','a',1,999)])]);assert.equal((await f.report()).summary.cost,80);
 await f.db.collection('documents').insertMany([doc('one','purchase','2026-08-05',[line('p1','a',1,90)],{sequence:1}),doc('two','purchase','2026-08-05',[line('p2','a',1,100)],{sequence:2})]);assert.equal((await f.report()).summary.cost,100);
 await f.db.collection('documents').updateMany({id:{$in:['one','two']}},{$unset:{sequence:1}});assert.equal((await f.report()).summary.costKnown,false);
});

test('an opening clearance does not supply its obsolete unit cost to later sales', async t => {
  const f = await fixture(t);
  await f.db.collection('documents').insertMany([
    doc('opening', 'adjustment', '2026-08-01', [line('o', 'a', 2, 80)], { number: 'OPEN-1', openingStockAfter: 2, openingCostAfter: 80 }),
    doc('clearance', 'adjustment', '2026-08-03', [line('c', 'a', -2, 80)], { number: 'OPEN-COR-1', openingCorrection: true, openingStockAfter: 0, openingCostAfter: null }),
    doc('before', 'sale', '2026-08-02', [line('b', 'a', 1, 150)]),
    doc('after', 'sale', '2026-08-10', [line('s', 'a', 1, 150)]),
  ]);
  const report = await f.report('sales');
  const before = report.rows.find(row => row.documentId === 'before');
  const after = report.rows.find(row => row.documentId === 'after');
  assert.deepEqual([before.cost, before.costKnown], [80, true]);
  assert.deepEqual([after.costKnown, after.unknownRevenue], [false, 150]);
});

test('an unpriced product added in an edit does not inherit the cost from the original invoice date', async t => {
  const f = await fixture(t);
  await f.db.collection('documents').insertMany([
    doc('old-buy', 'purchase', '2026-08-01', [line('o', 'a', 2, 80)]),
    doc('sale', 'sale', '2026-08-02', [line('new-line', 'a', 1, 150, null)], { revision: 1 }),
    doc('new-buy', 'purchase', '2026-08-03', [line('n', 'a', 1, 0)]),
  ]);
  await f.db.collection('stockMovements').insertOne({ id: 'edit', documentId: 'sale', productId: 'a', type: 'sale-edit', quantityDelta: -1 });
  const report = await f.report('sales');
  assert.deepEqual([report.rows[0].costKnown, report.rows[0].unknownRevenue], [false, 150]);
});

test('discount allocation preserves source data, is idempotent and reconciles full/filtered revenues with historical COGS',async t=>{
 const f=await fixture(t),sale=doc('discount','sale','2026-08-10',[line('a','a',1,100,60),line('b','b',1,50,20)],{total:140,paidTotal:140,legacy:{source:'dataacc-sqlite'}}),before=structuredClone(sale);await f.db.collection('documents').insertOne(sale);
 const net=reportNetLines(sale);close(net.reduce((sum,line)=>sum+line.lineTotal,0),140);assert.deepEqual(sale,before);assert.deepEqual(reportNetLines({...sale,lines:net}),net);assert.deepEqual(net.map(line=>line.costAtSale),[60,20]);
 for(const type of ['profit','sales','product-sales','overview']){const report=await f.report(type);close(report.summary[type==='profit'?'revenue':type==='sales'?'netSales':'sales'],140);close(report.summary[type==='overview'?'salesProfit':'profit'],60);assert.equal(report.summary.costKnown,true);}
 const first=await f.report('profit',{productId:'a'}),second=await f.report('profit',{productId:'b'}),category=await f.report('profit',{categoryId:'cat-a'});close(first.summary.revenue+second.summary.revenue,140);close(first.summary.cost,60);close(second.summary.cost,20);close(first.summary.revenue,category.summary.revenue);assert.deepEqual(await f.db.collection('documents').findOne({id:sale.id}).then(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_id'))),before);
 const day=await f.report('profit',{allTime:'false',from:'2026-08-10',to:'2026-08-10'});close(day.summary.revenue,140);close(day.summary.profit,60);
});

test('legacy supplier returns reduce only purchase quantities and values, with signed source rows and period-safe parent classification',async t=>{
 const f=await fixture(t);await f.db.collection('parties').insertOne({id:'supplier',name:'Synthetic supplier',partyType:'supplier',receivable:0,payable:100});await f.db.collection('documents').insertMany([doc('buy','purchase','2026-08-01',[line('b','a',2,100)],{partyId:'supplier',dueTotal:200}),doc('return','return','2026-08-05',[line('r','a',1,100,999)],{parentDocumentId:'buy',partyId:'supplier',dueTotal:100})]);
 const overview=await f.report('overview'),profit=await f.report(),purchases=await f.report('purchases'),product=await f.report('product-sales',{productId:'a'}),ledger=await f.report('party-ledger',{partyId:'supplier'});assert.equal(overview.summary.sales,0);assert.equal(overview.summary.salesCost,0);assert.equal(overview.summary.purchases,100);assert.equal(profit.summary.revenue,0);assert.equal(purchases.summary.total,100);assert.equal(purchases.summary.quantity,1);assert.equal(purchases.summary.count,1);assert.equal(purchases.summary.returnCount,1);assert.equal(purchases.rows.find(row=>row.documentId==='return').total,-100);assert.equal(product.rows[0].soldQuantity,0);assert.equal(product.rows[0].netPurchases,100);assert.equal(product.rows[0].purchasedQuantity,1);assert.equal(ledger.summary.tradeTotal,100);assert.equal(ledger.summary.debitTotal,100);assert.equal(ledger.summary.creditTotal,200);const party=calculatePartyFinancialSummaries(await f.db.collection('documents').find().toArray(),[]).find(row=>row.partyId==='supplier');assert.equal(party.supplierTradeTotal,purchases.summary.total);assert.equal(party.supplierInvoiceCount,1);assert.equal(party.customerTradeTotal,0);assert.equal(party.customerGrossProfit,0);
 const period={allTime:'false',from:'2026-08-05',to:'2026-08-05'};assert.equal((await f.report('overview',period)).summary.purchases,-100);assert.equal((await f.report('sales',period)).summary.netSales,0);assert.equal((await f.report('purchases',{...period,productId:'a'})).summary.total,-100);
});

test('discounted customer returns retain original-date cost and net refund without affecting purchases',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertMany([doc('buy','purchase','2026-08-01',[line('b','a',2,100)]),doc('sale','sale','2026-08-10',[line('s','a',1,150)],{total:140}),doc('later','purchase','2026-08-15',[line('p2','a',1,999)]),doc('return','return','2026-08-20',[line('r','a',1,150)],{total:140,parentDocumentId:'sale'})]);
 const full=await f.report();assert.equal(full.summary.revenue,0);assert.equal(full.summary.cost,0);assert.equal(full.summary.profit,0);assert.equal(full.summary.costKnown,true);
 const period=await f.report('profit',{allTime:'false',from:'2026-08-20',to:'2026-08-20'});assert.equal(period.summary.revenue,-140);assert.equal(period.summary.cost,-100);assert.equal(period.summary.profit,-40);assert.equal((await f.report('overview')).summary.purchases,1199);
});

test('header-only free discount retains zero net revenue without dropping known cost or masking unknown cost',async t=>{
 const f=await fixture(t);await f.db.collection('documents').insertOne(doc('free','sale','2026-08-10',[line('s','a',1,150,100)],{total:0}));const known=await f.report();assert.equal(known.summary.revenue,0);assert.equal(known.summary.cost,100);assert.equal(known.summary.profit,-100);assert.equal(known.summary.costKnown,true);
 await f.db.collection('documents').updateOne({id:'free'},{$set:{lines:[line('s','a',1,150,null)]}});const unknown=await f.report();assert.equal(unknown.summary.revenue,0);assert.equal(unknown.summary.unknownRevenue,0);assert.equal(unknown.summary.costKnown,false);
});

test('actual DataAcc discounted import reports net profit once while raw lines, costs and cash history stay intact',async t=>{
 const f=await fixture(t),initSqlJs=(await import('sql.js')).default,SQL=await initSqlJs(),legacy=new SQL.Database();
 legacy.run("CREATE TABLE itemsTB(id INTEGER,title TEXT);INSERT INTO itemsTB VALUES(1,'Imported synthetic');CREATE TABLE storesTB(id INTEGER,title TEXT);INSERT INTO storesTB VALUES(1,'Imported warehouse');CREATE TABLE stores_itemsTB(item_idFK INTEGER,store_idFK INTEGER,qty REAL);CREATE TABLE customerTB(id INTEGER,title TEXT);INSERT INTO customerTB VALUES(1,'Imported synthetic customer');CREATE TABLE buyBillTB(id INTEGER,Date TEXT,priceBillAfterKhasm REAL,PaidMony REAL,remainMony REAL,MoneyCash REAL,StoreFK INTEGER,CustomerFK INTEGER);INSERT INTO buyBillTB VALUES(1,'2026-08-10',140,140,0,140,1,1);CREATE TABLE items_BuyTB(id INTEGER,BuyFK INTEGER,item_idFK INTEGER,qty REAL,price_Buy REAL,LastCost REAL);INSERT INTO items_BuyTB VALUES(1,1,1,1,150,100);CREATE TABLE purchBillTB(id INTEGER);CREATE TABLE items_purchTB(purchFK INTEGER,item_idFK INTEGER);");const bytes=legacy.export();legacy.close();
 await f.db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,balance:1000,openingBalance:1000});
 const {executeLegacyImport}=await import('../legacy/dataacc-sqlite.ts');await executeLegacyImport(f.db,null,bytes);
 const original=await f.db.collection('documents').findOne({kind:'sale'}),money=await f.db.collection('financialMovements').find().toArray();assert.equal(original.total,140);assert.equal(original.lines[0].lineTotal,150);assert.equal(original.lines[0].costAtSale,100);assert.ok(original.partyId);const party=calculatePartyFinancialSummaries([original],money).find(row=>row.partyId===original.partyId);assert.equal(party.customerTradeTotal,140);assert.equal(party.customerGrossProfit,40);
 const profit=await f.report(),overview=await f.report('overview'),cash=await f.report('financial');assert.equal(profit.summary.revenue,140);assert.equal(profit.summary.cost,100);assert.equal(profit.summary.profit,40);close(profit.summary.margin,40/140*100);assert.equal(overview.summary.sales,140);assert.equal(overview.summary.salesProfit,40);assert.equal(overview.summary.netOperatingResult,40);assert.equal(cash.summary.businessIncoming,140);assert.deepEqual(await f.db.collection('documents').findOne({id:original.id}),original);assert.deepEqual(await f.db.collection('financialMovements').find().toArray(),money);
});

test('a canceled latest purchase is an uncertainty barrier for an old missing snapshot even when opening stock can absorb its void',async t=>{
 const f=await fixture(t),{execute}=await import('../app/api/command/route.ts'),run=body=>f.db.transaction(session=>execute(f.db,session,body));await f.db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',isActive:true,balance:10000,openingBalance:10000});
 const product=await run({type:'product.create',name:'Synthetic opening and purchase',pieceCost:80,piecePrice:150,openingStock:10,openingWarehouseId:'w'}),buy=await run({type:'purchase.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:product,quantity:10,unitPrice:100}]}),sale=await run({type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId:product,quantity:1,piecePrice:150}]});
 assert.equal((await f.db.collection('documents').findOne({id:sale})).lines[0].costAtSale,100);await run({type:'purchase.void',documentId:buy,expectedRevision:0});assert.equal((await f.db.collection('products').findOne({id:product})).stocks.w,9);assert.equal((await f.report()).summary.cost,100);
 const original=await f.db.collection('documents').findOne({id:sale});await f.db.collection('documents').updateOne({id:sale},{$set:{lines:original.lines.map(line=>({...line,costAtSale:null,grossProfit:null}))}});const unknown=await f.report();assert.equal(unknown.summary.costKnown,false);assert.equal(unknown.summary.unknownRevenue,150);assert.equal(unknown.summary.cost,0);
 await f.db.collection('documents').updateOne({id:sale},{$set:{lines:original.lines.map(line=>({...line,costAtSale:0,grossProfit:150}))}});const zero=await f.report();assert.equal(zero.summary.costKnown,true);assert.equal(zero.summary.cost,0);assert.equal(zero.summary.unknownRevenue,0);
});

test('a copied legacy partial customer return keeps its represented party profit and cannot confirm conflicting report profit',async t=>{
 const f=await fixture(t),sale=doc('sale','sale','2026-08-10',[{...line('s','a',2,50,30),grossProfit:40}],{partyId:'customer'}),returned=doc('return','return','2026-08-11',[{...sale.lines[0],id:'r',grossProfit:10}],{partyId:'customer',parentDocumentId:'sale',total:25}),before=structuredClone([sale,returned]);await f.db.collection('documents').insertMany([sale,returned]);
 const report=await f.report(),overview=await f.report('overview'),party=calculatePartyFinancialSummaries([sale,returned],[]).find(row=>row.partyId==='customer');assert.equal(party.customerTradeTotal,75);assert.equal(party.customerGrossProfit,30);assert.equal(report.summary.revenue,75);assert.equal(report.summary.costKnown,false);assert.equal(report.summary.unknownRevenue,25);assert.equal(report.rows.find(row=>row.documentId==='return').costKnown,false);assert.equal(overview.summary.costKnown,false);assert.equal(overview.summary.unknownRevenue,25);assert.deepEqual((await f.db.collection('documents').find().toArray()).map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_id'))),before);
});

test('coherent legacy return profits matching raw or net revenue, including explicit zero cost, remain confirmed',async t=>{
 const f=await fixture(t);
 for(const [cost,grossProfit,header,rawPrice] of [[100,50,140,150],[100,40,140,150],[0,50,50,50]]){await f.db.collection('documents').deleteMany({});await f.db.collection('documents').insertMany([doc('sale','sale','2026-08-10',[line('s','a',1,150,cost)]),doc('return','return','2026-08-11',[{...line('r','a',1,rawPrice,cost),grossProfit}],{parentDocumentId:'sale',total:header})]);const report=await f.report();assert.equal(report.summary.costKnown,true);assert.equal(report.summary.unknownRevenue,0);assert.equal(report.rows.find(row=>row.documentId==='return').costKnown,true);}
});
