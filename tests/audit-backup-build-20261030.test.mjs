import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createNativeBackup,parseAndValidateBackup,restoreNativeBackup,stringifyBackup} from '../lib/backup.ts';
import {sqliteHarness} from './sqlite-harness.mjs';

const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
function environment(t,values){
 const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 for(const[k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
 t.after(()=>{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v});
}
async function harness(t){const h=await sqliteHarness();t.after(()=>h.close());return h}

test('audit: desktop backup identifies its actual application without npm runtime variables',async t=>{
 environment(t,{npm_package_version:undefined,ALKARNA_BUILD_COMMIT:undefined,ALKARNA_BUILD_NUMBER:undefined});
 const h=await harness(t),backup=await createNativeBackup(h.db);
 assert.equal(backup.appVersion,pkg.version);
 assert.deepEqual(backup.application,{packageName:pkg.name});
 assert.equal(backup.build,undefined,'local runs must not invent a source commit or build number');
});

test('audit: unrelated npm metadata and environment secrets cannot identify or leak into backups',async t=>{
 environment(t,{npm_package_version:'999.999.999',GITHUB_SHA:'c'.repeat(40),GITHUB_TOKEN:'never-export-this-token',ALKARNA_BUILD_COMMIT:'not-a-commit/SECRET',ALKARNA_BUILD_NUMBER:'private-value'});
 const h=await harness(t),backup=await createNativeBackup(h.db),json=stringifyBackup(backup);
 assert.equal(backup.appVersion,pkg.version);
 assert.deepEqual(backup.application,{packageName:pkg.name});
 assert.equal(backup.build,undefined);
 for(const value of ['999.999.999','never-export-this-token','private-value','SECRET','c'.repeat(40)])assert.ok(!json.includes(value));
});

test('audit: backups retain only validated public build identifiers alongside application version',async t=>{
 environment(t,{ALKARNA_BUILD_COMMIT:'A1'.repeat(20),ALKARNA_BUILD_NUMBER:'451',npm_package_version:undefined});
 const h=await harness(t),backup=await createNativeBackup(h.db),parsed=parseAndValidateBackup(stringifyBackup(backup));
 assert.equal(parsed.appVersion,pkg.version);
 assert.deepEqual(parsed.build,{commit:'a1'.repeat(20),number:'451'});
 assert.deepEqual(parsed.application,{packageName:pkg.name});
 assert.deepEqual(parsed.collections,backup.collections);
});

test('audit: backup round trips and historical metadata remain compatible',async t=>{
 environment(t,{ALKARNA_BUILD_COMMIT:undefined,ALKARNA_BUILD_NUMBER:undefined});
 const h=await harness(t);await h.db.collection('products').insertOne({id:'audit-backup-product',sku:'701',name:'Audit only',stocks:{}});
 const current=parseAndValidateBackup(stringifyBackup(await createNativeBackup(h.db)));
 await h.db.transaction(s=>restoreNativeBackup(h.db,current,s));
 assert.equal((await h.db.collection('products').findOne({id:'audit-backup-product'})).name,'Audit only');
 const old=structuredClone(current);delete old.application;delete old.build;old.appVersion='0.1.0';
 const historical=parseAndValidateBackup(JSON.stringify(old));
 await h.db.transaction(s=>restoreNativeBackup(h.db,historical,s));
 assert.equal((await h.db.collection('products').findOne({id:'audit-backup-product'})).name,'Audit only');
 assert.equal(historical.appVersion,'0.1.0','historical backup metadata must not be rewritten');
});

test('audit: Next seals only valid public CI build metadata into its runtime',async t=>{
 environment(t,{GITHUB_SHA:'B2'.repeat(20),GITHUB_RUN_NUMBER:'451',GITHUB_TOKEN:'never-inline-this-token'});
 const {default:valid}=await import('../next.config.ts?audit-valid-build');
 assert.deepEqual(valid.env,{ALKARNA_BUILD_COMMIT:'b2'.repeat(20),ALKARNA_BUILD_NUMBER:'451'});
 assert.equal(valid.output,'standalone');
 process.env.GITHUB_SHA='not-a-sha/private-value';process.env.GITHUB_RUN_NUMBER='private-value';
 const {default:invalid}=await import('../next.config.ts?audit-invalid-build');
 assert.deepEqual(invalid.env,{ALKARNA_BUILD_COMMIT:'',ALKARNA_BUILD_NUMBER:''});
 assert.ok(!JSON.stringify([valid,invalid]).includes('never-inline-this-token'));
});
