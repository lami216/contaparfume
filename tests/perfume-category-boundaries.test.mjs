import assert from 'node:assert/strict';
import test from 'node:test';
import {sqliteHarness} from './sqlite-harness.mjs';
import {GET as reports} from '../app/api/reports/route.ts';
import {GET as backup} from '../app/api/settings/backup/route.ts';
import {GET as desktopBackup} from '../app/api/desktop/backup/route.ts';
import {createSession} from '../lib/auth.ts';
import {buildReport,parseReportFilters} from '../lib/reports.ts';
import {FRAGRANCE_DEFAULT_CATEGORY} from '../lib/perfume-system-categories.ts';

async function fixture(t){
 const h=await sqliteHarness();t.after(()=>h.close());await h.reset();const db=h.db;
 await db.collection('warehouses').insertOne({_id:'w',name:'Main',isSalesDefault:true});
 await db.collection('paymentAccounts').insertOne({id:'cash',name:'Cash',code:'cash',isActive:true,balance:1000,openingBalance:990});
 await db.collection('productCategories').insertOne({id:'custom',name:'Custom'});
 await db.collection('products').insertMany([
  {id:'ordinary',sku:'1',name:'Ordinary',categoryId:null,perfumeForm:'full',stocks:{w:2},pieceCost:5,openingCost:5,lastPurchaseCost:5},
  {id:'archived',sku:'2',name:'Archived',isArchived:true,stocks:{w:0},pieceCost:5},
  {id:'custom-product',sku:'3',name:'Custom product',categoryId:'custom',stocks:{w:1},pieceCost:5},
 ]);
 await db.collection('documents').insertOne({id:'sale',number:'SAL-old',kind:'sale',status:'posted',warehouseId:'w',paymentMethod:'cash',total:10,paidTotal:10,cashAmount:10,occurredAt:'2026-01-01T00:00:00.000Z',lines:[{id:'line',productId:'ordinary',description:'Historical',quantity:1,unitPrice:10,lineTotal:10,costAtSale:5}]});
 const accounting=()=>Promise.all(['documents','stockMovements','financialMovements','paymentAccounts','warehouses'].map(name=>db.collection(name).find().toArray()));
 const summary=async()=>(await buildReport(db,parseReportFilters(new URL('http://local/api/reports?type=overview&allTime=true')))).summary;
 const metadata=()=>Promise.all(['products','productCategories','appSettings'].map(name=>db.collection(name).find().toArray()));
 return{db,accounting,summary,metadata};
}

for(const kind of ['reports','backup','desktop'])test(`${kind} actual GET normalizes old ordinary categories before first bootstrap without changing accounting`,async t=>{
 const f=await fixture(t),before=await f.accounting(),beforeSummary=await f.summary(),oldDesktop=process.env.ALKARNA_DESKTOP,oldToken=process.env.ALKARNA_DESKTOP_TOKEN;
 t.after(()=>{if(oldDesktop===undefined)delete process.env.ALKARNA_DESKTOP;else process.env.ALKARNA_DESKTOP=oldDesktop;if(oldToken===undefined)delete process.env.ALKARNA_DESKTOP_TOKEN;else process.env.ALKARNA_DESKTOP_TOKEN=oldToken;});
 process.env.ALKARNA_DESKTOP='1';process.env.ALKARNA_DESKTOP_TOKEN='synthetic-category-boundary';
 const response=kind==='reports'?await reports(new Request('http://localhost/api/reports?type=overview&allTime=true')):kind==='backup'?await backup(new Request('http://localhost/api/settings/backup')):await desktopBackup(new Request('http://localhost/api/desktop/backup',{headers:{'x-alkarna-desktop-token':'synthetic-category-boundary'}}));
 assert.equal(response.status,200);const payload=await response.json();
 const products=await f.db.collection('products').find().toArray();assert.equal(products.find(p=>p.id==='ordinary').categoryId,FRAGRANCE_DEFAULT_CATEGORY.id);assert.equal(products.find(p=>p.id==='archived').categoryId,FRAGRANCE_DEFAULT_CATEGORY.id);assert.equal(products.find(p=>p.id==='custom-product').categoryId,'custom');
 if(kind==='reports')assert.deepEqual(payload.summary,beforeSummary);else{assert.equal(payload.collections.products.find(p=>p.id==='ordinary').categoryId,FRAGRANCE_DEFAULT_CATEGORY.id);assert(payload.collections.productCategories.some(c=>c.id===FRAGRANCE_DEFAULT_CATEGORY.id));assert.equal(payload.collections.appSettings.find(s=>s._id==='perfume-fragrance-category').categoryId,FRAGRANCE_DEFAULT_CATEGORY.id);}
 assert.deepEqual(await f.accounting(),before);assert.deepEqual(await f.summary(),beforeSummary);
});

test('unauthorized report/backup and incorrect desktop token cannot trigger metadata migration',async t=>{
 const f=await fixture(t);await f.db.collection('users').insertOne({id:'viewer',name:'Viewer',username:'viewer',isActive:true,permissions:[]});
 const cookie=`conta_session=${createSession({principalType:'user',userId:'viewer'})}`,before=await f.metadata();
 const deniedReports=await reports(new Request('http://localhost/api/reports?type=overview&allTime=true',{headers:{cookie}}));assert.equal(deniedReports.status,403);
 const deniedBackup=await backup(new Request('http://localhost/api/settings/backup',{headers:{cookie}}));assert.equal(deniedBackup.status,403);
 const oldDesktop=process.env.ALKARNA_DESKTOP,oldToken=process.env.ALKARNA_DESKTOP_TOKEN;process.env.ALKARNA_DESKTOP='1';process.env.ALKARNA_DESKTOP_TOKEN='expected';
 try{const denied=await desktopBackup(new Request('http://localhost/api/desktop/backup',{headers:{'x-alkarna-desktop-token':'wrong'}}));assert.equal(denied.status,403);}finally{if(oldDesktop===undefined)delete process.env.ALKARNA_DESKTOP;else process.env.ALKARNA_DESKTOP=oldDesktop;if(oldToken===undefined)delete process.env.ALKARNA_DESKTOP_TOKEN;else process.env.ALKARNA_DESKTOP_TOKEN=oldToken;}
 assert.deepEqual(await f.metadata(),before);
});
