import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {createIsolatedBackupWriter}=require('../desktop/backup-writer.cjs');
const {createNativeBackupService}=require('../desktop/native-backup.cjs');
const {createCloseFlow}=require('../desktop/close-flow.cjs');
const workerModule=fileURLToPath(new URL('../desktop/backup-write-worker.cjs',import.meta.url));
const json=text=>new Response(text,{headers:{'content-type':'application/json'}});
async function fixture(t,options={}){
 const home=await fs.mkdtemp(join(tmpdir(),'backup-writer-test-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const target=join(home,'backup.conta.json'), owner={isDestroyed:()=>false}, stages=[];
 const service=createNativeBackupService({homeDirectory:home,getWindow:()=>owner,
  dialog:{showSaveDialog:async()=>({filePath:target,canceled:false})},log:s=>stages.push(s),
  writeBackup:createIsolatedBackupWriter(),timeoutMs:15000,...options});
 return {home,target,service,stages,owner};
}
async function stuckWorker(home,phase){
 const script=join(home,`stuck-${phase}.cjs`);
 const hang=`async()=>{process.send({type:'stage',line:'test stuck ${phase}'});return new Promise(()=>{});}`;
 const overrides=phase==='rm'?`rename:async()=>{throw Object.assign(Error('disk failure'),{code:'EIO'});},rm:${hang}`:`${phase}:${hang}`;
 await fs.writeFile(script,`const fs=require('node:fs/promises');const {runBackupWorker}=require(${JSON.stringify(workerModule)});runBackupWorker({io:{...fs,${overrides}}});`);
 return createIsolatedBackupWriter({workerPath:script});
}

test('isolated writer acknowledges only the fully written replacement and streams more than 5 MiB',async t=>{
 const f=await fixture(t),body=JSON.stringify({rows:'ع'.repeat(3*1024*1024)});
 await fs.writeFile(f.target,'{"old":true}');
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 let finished=false;
 const task=f.service.save(async()=>{await waiting;return json(body);}).then(r=>{finished=true;return r;});
 await new Promise(resolve=>setTimeout(resolve,80));
 assert.equal(finished,false);assert.equal(await fs.readFile(f.target,'utf8'),'{"old":true}');
 release();const result=await task;
 assert.equal(result.bytes,Buffer.byteLength(body));assert.equal(await fs.readFile(f.target,'utf8'),body);
 assert.equal(f.service.isActive(),false);assert.deepEqual(await fs.readdir(f.home),['backup.conta.json']);
});

for(const phase of ['lstat','open','rename','rm'])test(`a stalled ${phase} after Save cannot retain the backup/close barrier`,async t=>{
 const f=await fixture(t,{timeoutMs:1200});const writer=await stuckWorker(f.home,phase);
 const service=createNativeBackupService({homeDirectory:f.home,getWindow:()=>f.owner,timeoutMs:1200,
  dialog:{showSaveDialog:async()=>({filePath:f.target})},writeBackup:writer,log:s=>f.stages.push(s)});
 await fs.writeFile(f.target,'{"old":true}');
 let ticks=0;const heartbeat=setInterval(()=>ticks++,20);const start=Date.now();
 try{await assert.rejects(service.save(async()=>json('{"new":true}')),{code:'backup-write-timeout'});}
 finally{clearInterval(heartbeat);}
 assert.ok(Date.now()-start<5000);assert.ok(ticks>5,'application event loop remains responsive');
 assert.ok(f.stages.includes(`test stuck ${phase}`),'fault stage was actually entered');
 assert.equal(service.isActive(),false);await service.waitForIdle();
 assert.equal(await fs.readFile(f.target,'utf8'),'{"old":true}');
});

test('timeout bounds a response provider that ignores AbortSignal, and a fresh save can succeed',async t=>{
 const f=await fixture(t,{timeoutMs:1200});
 await assert.rejects(f.service.save(()=>new Promise(()=>{})),{code:'backup-write-timeout'});
 assert.equal(f.service.isActive(),false);
 const retry=await f.service.save(async()=>json('{"retry":true}'));
 assert.equal(retry.ok,true);assert.equal(await fs.readFile(f.target,'utf8'),'{"retry":true}');
});

test('isolated writer preserves previous backup for HTTP failure, invalid content and truncated data',async t=>{
 const f=await fixture(t);await fs.writeFile(f.target,'{"old":true}');
 await assert.rejects(f.service.save(async()=>new Response('denied',{status:403})),e=>e.status===403);
 await assert.rejects(f.service.save(async()=>new Response('<html>error</html>')),{code:'invalid-backup-response'});
 await assert.rejects(f.service.save(async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'99'}})),{code:'incomplete-backup-response'});
 assert.equal(await fs.readFile(f.target,'utf8'),'{"old":true}');
 assert.deepEqual(await fs.readdir(f.home),['backup.conta.json']);
});

test('canceling native Save As launches no writer, while a slow folder choice has no disk timeout',async t=>{
 let writes=0,release;const choice=new Promise(resolve=>{release=resolve;});
 const f=await fixture(t,{timeoutMs:40,dialog:{showSaveDialog:()=>choice},writeBackup:async()=>{writes++;return{bytes:2};}});
 const saving=f.service.save(async()=>json('{}'));
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(writes,0);
 release({canceled:true});assert.deepEqual(await saving,{ok:true,canceled:true});assert.equal(writes,0);
});

test('a stalled destination during save-and-exit reports failure and keeps the application open',async t=>{
 const f=await fixture(t);const writer=await stuckWorker(f.home,'rename');
 const service=createNativeBackupService({homeDirectory:f.home,getWindow:()=>f.owner,timeoutMs:1200,
  dialog:{showSaveDialog:async()=>({filePath:f.target})},writeBackup:writer});
 await fs.writeFile(f.target,'{"old":true}');let quits=0,failures=0;
 const flow=createCloseFlow({dialog:{showMessageBox:async()=>({response:0})},window:()=>f.owner,
  saveBackup:()=>service.save(async()=>json('{}')),onFailure:async error=>{assert.equal(error.code,'backup-write-timeout');failures++;},approveQuit:async()=>quits++});
 assert.equal(await flow.requestClose(),false);assert.equal(quits,0);assert.equal(failures,1);
 assert.equal(service.isActive(),false);assert.equal(flow.isActive(),false);
 assert.equal(await fs.readFile(f.target,'utf8'),'{"old":true}');
});
