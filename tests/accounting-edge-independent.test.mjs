import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const source=path.resolve(process.env.ACCOUNTING_EDGE_SOURCE??fileURLToPath(new URL('../',import.meta.url)));
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const fixtureParent=path.resolve(process.env.ACCOUNTING_EDGE_AUDIT??os.tmpdir());
const preserveProfiles=Boolean(process.env.ACCOUNTING_EDGE_AUDIT);
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
let sqlite;
async function fixture(t,label){
 sqlite?.closeDatabase();fs.mkdirSync(fixtureParent,{recursive:true});
 const profile=fs.mkdtempSync(path.join(fixtureParent,'accounting-edge-'+label+'-'));
 for(const folder of ['data','config','licensing','temp'])fs.mkdirSync(path.join(profile,folder));
 Object.assign(process.env,{ALKARNA_USER_DATA:profile,ALKARNA_DATABASE_PATH:path.join(profile,'data/audit.sqlite'),ALKARNA_LICENSE_STATE_PATH:path.join(profile,'licensing/state-v2.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1',ALKARNA_DESKTOP:'1',TEMP:path.join(profile,'temp'),TMP:path.join(profile,'temp')});
 sqlite??=await load('lib/sqlite.ts');const db=sqlite.initializeDatabase();await db.dropDatabase();
 const{POST}=await load('app/api/command/route.ts'),{GET}=await load('app/api/reports/route.ts'),auth=await load('lib/auth.ts');
 await db.collection('warehouses').insertOne({_id:'w',name:'Synthetic warehouse',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',code:'cash',name:'Synthetic cash',balance:10000,openingBalance:10000,isActive:true});
 await db.collection('users').insertMany(['buyer','seller'].map(id=>({id,username:id,name:'Synthetic '+id,isActive:true,permissions:['products.create','purchases.create','pos.create','reports.view']})));
 const origin='http://127.0.0.1:3398';
 const headers=(user,key)=>({Origin:origin,Host:'127.0.0.1:3398',Cookie:auth.SESSION_COOKIE+'='+auth.createSession({principalType:'user',userId:user}),'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})});
 const request=(body,user='buyer',key=randomUUID())=>new Request(origin+'/api/command',{method:'POST',headers:headers(user,key),body:JSON.stringify(body)});
 const respond=async req=>{const response=await POST(req);return{status:response.status,body:await response.json()}};
 const post=(body,user='buyer',key)=>respond(request(body,user,key));
 const created=await post({type:'product.create',name:'Synthetic '+label,pieceCost:0,piecePrice:150});assert.equal(created.status,200,JSON.stringify(created));
 const productId=created.body.id;
 // Legacy/imported available stock without proved historical cost makes an early sale observable.
 await db.collection('products').updateOne({id:productId},{$set:{stocks:{w:2}}});
 const purchaseBody={type:'purchase.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId,quantity:1,unitPrice:100}]};
 const saleBody={type:'sale.post',warehouseId:'w',paymentMethod:'cash',lines:[{productId,quantity:1,piecePrice:150}]};
 function held(){
  let controller,notifyRead;const reading=new Promise(resolve=>{notifyRead=resolve});
  const stream=new ReadableStream({start(value){controller=value},pull(){notifyRead()}},{highWaterMark:0});
  const aborter=new AbortController(),key=randomUUID();let finished=false;
  const req=new Request(origin+'/api/command',{method:'POST',headers:headers('buyer',key),body:stream,signal:aborter.signal,duplex:'half'});
  return{key,reading,abort:()=>aborter.abort(),response:respond(req),release(value=JSON.stringify(purchaseBody)){if(finished)return;finished=true;controller.enqueue(new TextEncoder().encode(value));controller.close()},fail(){if(finished)return;finished=true;controller.error(new Error('Synthetic unreadable request body'))}};
 }
 const report=async()=>{const response=await GET(new Request(origin+'/api/reports?type=sales&allTime=true',{headers:headers('seller')}));assert.equal(response.status,200);return response.json()};
 const doc=id=>db.collection('documents').findOne({id});
 t.after(()=>{sqlite.closeDatabase();if(!preserveProfiles&&fs.existsSync(profile)){const relative=path.relative(fs.realpathSync(fixtureParent),fs.realpathSync(profile));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Only remove the owned synthetic profile');fs.rmSync(profile,{recursive:true,force:true})}});
 return{db,profile,post,held,report,doc,productId,purchaseBody,saleBody};
}
async function assertWaiting(promise){let completed=false;void promise.then(()=>{completed=true},()=>{completed=true});await pause(30);assert.equal(completed,false,'Following sale must wait for the earlier admitted purchase body');}
async function assertPreflightOnly(f,held){assert.equal(f.db.native.inTransaction,false,'Waiting for a request body must not hold a SQLite transaction');assert.equal(await f.db.collection('commandReceipts').findOne({_id:held.key}),null);assert.equal((await f.report()).summary.count,0,'Independent report reads remain available while the command body is pending');}
async function assertUnknownSale(f,response,failedKey){
 assert.equal(response.status,200,JSON.stringify(response));const sale=await f.doc(response.body.id);assert.equal(sale.lines[0].costAtSale,null);assert.equal(sale.lines[0].grossProfit,null);
 const report=await f.report();assert.equal(report.summary.unknownRevenue,150);assert.equal(report.summary.costKnown,false);
 assert.equal(await f.db.collection('documents').countDocuments({kind:'purchase'}),0);assert.equal(await f.db.collection('commandReceipts').findOne({_id:failedKey}),null);
 assert.equal((await f.db.collection('products').findOne({id:f.productId})).stocks.w,1);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10150);
 return sale;
}

test('admitted held purchase body stays ahead of a different authenticated seller and preserves idempotency',async t=>{
 const f=await fixture(t,'held-valid'),held=f.held();let salePromise;
 try{
  await held.reading;const key=randomUUID();salePromise=f.post(f.saleBody,'seller',key);await assertWaiting(salePromise);await assertPreflightOnly(f,held);
  held.release();assert.equal((await held.response).status,200);const sale=await salePromise;assert.equal(sale.status,200,JSON.stringify(sale));
  const document=await f.doc(sale.body.id);assert.equal(document.lines[0].costAtSale,100);assert.equal(document.lines[0].grossProfit,50);
  const report=await f.report();assert.equal(report.summary.cost,100);assert.equal(report.summary.profit,50);assert.equal(report.summary.unknownRevenue,0);
  const stock=(await f.db.collection('products').findOne({id:f.productId})).stocks.w,cash=(await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance;
  assert.deepEqual(await f.post(f.saleBody,'seller',key),sale);assert.equal((await f.db.collection('products').findOne({id:f.productId})).stocks.w,stock);assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,cash);
 }finally{held.release();await Promise.allSettled([held.response,...(salePromise?[salePromise]:[])])}
});

for(const failure of ['business-invalid','malformed-json','body-error','aborted'])test(`failed ${failure} earlier body releases the sale with honest unknown cost and no partial purchase`,async t=>{
 const f=await fixture(t,failure),held=f.held();let salePromise;
 try{
  await held.reading;salePromise=f.post(f.saleBody,'seller');await assertWaiting(salePromise);await assertPreflightOnly(f,held);
  if(failure==='business-invalid')held.release(JSON.stringify({...f.purchaseBody,lines:[{...f.purchaseBody.lines[0],unitPrice:0}]}));
  else if(failure==='malformed-json')held.release('{');else if(failure==='body-error')held.fail();else held.abort();
  const failed=await held.response;assert.equal(failed.status,failure==='business-invalid'?400:failure==='aborted'?408:500);assert.equal(typeof failed.body.error,'string');assert.equal(failed.body.stack,undefined);
  await assertUnknownSale(f,await salePromise,held.key);
  if(failure==='aborted'){held.release();await pause(25);assert.equal(await f.db.collection('documents').countDocuments({kind:'purchase'}),0)}
  const nextPurchase=await f.post(f.purchaseBody,'buyer',held.key);assert.equal(nextPurchase.status,200,JSON.stringify(nextPurchase));const nextSale=await f.post(f.saleBody,'seller');assert.equal(nextSale.status,200);assert.equal((await f.doc(nextSale.body.id)).lines[0].costAtSale,100);
 }finally{held.release();await Promise.allSettled([held.response,...(salePromise?[salePromise]:[])])}
});

test('actual production body deadline releases the queued sale and ignores a valid late purchase body',async t=>{
 const f=await fixture(t,'real-timeout'),held=f.held();let salePromise;
 try{
  await held.reading;salePromise=f.post(f.saleBody,'seller');await assertWaiting(salePromise);await assertPreflightOnly(f,held);
  const failed=await held.response;assert.equal(failed.status,408);assert.match(failed.body.error,/مهلة قراءة/);
  await assertUnknownSale(f,await salePromise,held.key);held.release();await pause(35);
  assert.equal(await f.db.collection('documents').countDocuments({kind:'purchase'}),0);assert.equal(await f.db.collection('commandReceipts').findOne({_id:held.key}),null);
  assert.equal((await f.db.collection('paymentAccounts').findOne({id:'cash'})).balance,10150);
  const next=await f.post(f.purchaseBody,'buyer',held.key);assert.equal(next.status,200);assert.equal((await f.post(f.saleBody,'seller')).status,200);
 }finally{held.release();await Promise.allSettled([held.response,...(salePromise?[salePromise]:[])])}
});

test('actual tiny positive purchase cost remains raw positive and the report margin stays strictly below100',async t=>{
 const f=await fixture(t,'tiny-positive');
 const purchase=await f.post({...f.purchaseBody,lines:[{...f.purchaseBody.lines[0],unitPrice:0.0001}]});assert.equal(purchase.status,200);
 const sale=await f.post({...f.saleBody,lines:[{...f.saleBody.lines[0],piecePrice:1000000}]},'seller');assert.equal(sale.status,200);
 const document=await f.doc(sale.body.id),report=await f.report();assert.equal(document.lines[0].costAtSale,0.0001);assert.equal(report.summary.cost,0.0001);assert(report.summary.margin<100);assert(report.summary.margin>99.99);assert.equal(report.summary.unknownRevenue,0);
});

test('accounting-specific displays preserve tiny signs and never round a below100 ratio to100',async()=>{
 const{formatAccountingDecimal,formatAccountingPercentage}=await load('lib/accounting-format.ts');
 for(const cost of [0.0001,1e-9,1e-20])for(const sign of [1,-1]){const rendered=formatAccountingDecimal('en-US',cost*sign);const number=Number(rendered.replaceAll(',',''));assert(Number.isFinite(number));assert.equal(Math.sign(number),sign);}
 for(const margin of [99.9999,99.99999999999999]){const rendered=formatAccountingPercentage('en-US',margin).replaceAll(' ','');assert.notEqual(rendered,'100%');if(!rendered.startsWith('<'))assert(Number(rendered.replace('%','').replaceAll(',',''))<100);}
 assert.equal(formatAccountingDecimal('en-US',0),'0');assert.equal(formatAccountingPercentage('en-US',100).replaceAll(' ',''),'100%');assert.equal(formatAccountingPercentage('en-US',0).replaceAll(' ',''),'0%');
});

test('XLSX retains tiny numeric cells and truthful near100 formats while preserving exact zero100 and unknown text',async()=>{
 const{createXlsx}=await load('app/xlsx-export.ts');
 const values=[[0.0001,99.9999],[1e-20,99.99999999999999],[0,100],['غير مؤكد','غير مؤكد']];
 const bytes=Buffer.from(createXlsx([{name:'Synthetic accounting',rows:[['Cost','Margin'],...values],cellFormats:[[null,null],...values.map(()=>['number','percent'])]}]));
 const entries={};let offset=0;
 while(bytes.readUInt32LE(offset)===0x04034b50){const method=bytes.readUInt16LE(offset+8),size=bytes.readUInt32LE(offset+18),nameSize=bytes.readUInt16LE(offset+26),extraSize=bytes.readUInt16LE(offset+28);assert.equal(method,0);const name=bytes.subarray(offset+30,offset+30+nameSize).toString(),start=offset+30+nameSize+extraSize;entries[name]=bytes.subarray(start,start+size).toString();offset=start+size;}
 const sheet=entries['xl/worksheets/sheet1.xml'],styles=entries['xl/styles.xml'];assert(sheet&&styles);
 const xfs=/<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(styles)[1].match(/<xf\b[^>]*\/>/g);
 const formats=Object.fromEntries([...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].map(m=>[m[1],m[2].replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')]));
 function numericCell(ref){const m=new RegExp(`<c r="${ref}"([^>]*)><v>([^<]+)<\\/v><\\/c>`).exec(sheet);assert(m,'Expected real numeric '+ref);const style=Number(/s="(\d+)"/.exec(m[1])?.[1]??0),formatId=/numFmtId="(\d+)"/.exec(xfs[style])[1];return{value:Number(m[2]),format:formats[formatId]??'General'};}
 const tiny=numericCell('A2');assert.equal(tiny.value,0.0001);const precision=/\.([#0]+)/.exec(tiny.format)?.[1].length??0;assert(precision>=4,'Tiny positive cost must be visible under its Excel format');
 const scientific=numericCell('A3');assert.equal(scientific.value,1e-20);assert.match(scientific.format,/E[+-]00/i);
 const almost=numericCell('B2');assert.equal(almost.value,99.9999);assert((/\.([#0]+)/.exec(almost.format)?.[1].length??0)>=4);
 const bound=numericCell('B3');assert(bound.value<100);assert.match(bound.format,/<100%/);assert.doesNotMatch(bound.format,/>100%/);
 assert.equal(numericCell('A4').value,0);const exact=numericCell('B4');assert.equal(exact.value,100);assert(!exact.format.includes('<')&&!exact.format.includes('>'));
 assert.match(sheet,/<c r="A5"[^>]*t="inlineStr"[^>]*>.*?غير مؤكد/);assert.match(sheet,/<c r="B5"[^>]*t="inlineStr"[^>]*>.*?غير مؤكد/);
});
