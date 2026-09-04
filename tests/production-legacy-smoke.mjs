import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import initSqlJs from "sql.js";
import { MongoMemoryServer } from "mongodb-memory-server";

const port = 3219;
const origin = `http://127.0.0.1:${port}`;
const secret = "production-smoke-session-secret-at-least-32-characters";
const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+600 })).toString("base64url");
const cookie = `conta_session=${payload}.${createHmac("sha256",secret).update(payload).digest("base64url")}`;
const headers = { cookie, origin, "x-forwarded-proto":"http" };

assert.equal(existsSync(".next/standalone/node_modules/sql.js/dist/sql-wasm.wasm"),true,"standalone output must contain sql-wasm.wasm");
const SQL=await initSqlJs(),db=new SQL.Database();
db.run("CREATE TABLE itemsTB(id INTEGER,title TEXT); INSERT INTO itemsTB VALUES(1,'A'),(2,'B'); CREATE TABLE storesTB(id INTEGER,Name TEXT); INSERT INTO storesTB VALUES(1,'Main');");
const bytes=db.export();db.close();
const mongo=await MongoMemoryServer.create();
const server=spawn(process.execPath,["server.js"],{cwd:".next/standalone",env:{...process.env,PORT:String(port),HOSTNAME:"127.0.0.1",SESSION_SECRET:secret,MONGODB_URI:mongo.getUri(),MONGODB_DB:"legacy-production-smoke"},stdio:["ignore","pipe","pipe"]});
let logs=""; server.stdout.on("data",d=>logs+=d);server.stderr.on("data",d=>logs+=d);
try {
  for(let i=0;i<60;i++){try{if((await fetch(`${origin}/login`)).status<500)break;}catch{}await delay(250);}
  const start=await fetch(`${origin}/api/settings/legacy/upload/start`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({size:bytes.length})});
  if(start.status!==200)assert.fail(`start returned ${start.status}: ${await start.text()}`);const upload=await start.json();
  for(let index=0,offset=0;offset<bytes.length;index++,offset+=upload.chunkSize){const response=await fetch(`${origin}/api/settings/legacy/upload/chunk?uploadId=${upload.uploadId}&index=${index}`,{method:"POST",headers:{...headers,"content-type":"application/octet-stream"},body:bytes.slice(offset,offset+upload.chunkSize)});if(response.status!==200)assert.fail(`chunk returned ${response.status}: ${await response.text()}`);}
  const complete=await fetch(`${origin}/api/settings/legacy/upload/complete`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({uploadId:upload.uploadId,action:"preview"})});
  if(complete.status!==200)assert.fail(`complete returned ${complete.status}: ${await complete.text()}`);const preview=await complete.json();
  assert.equal(preview.groups.find(x=>x.key==="products").count,2);assert.equal(preview.groups.find(x=>x.key==="warehouses").count,1);
  const begin=await fetch(`${origin}/api/settings/legacy/upload/complete`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({uploadId:upload.uploadId,action:"import"})});assert.equal(begin.status,202);let run=await begin.json();
  const statusUrl=`${origin}/api/settings/legacy/import-runs/${run.importRunId}`,advanceUrl=`${statusUrl}/advance`,getHeaders={cookie,"x-forwarded-proto":"http"};
  const initialStatus=await fetch(statusUrl,{headers:getHeaders});assert.equal(initialStatus.status,200);const initial=await initialStatus.json();assert.equal(initial.phase,run.phase);assert.deepEqual(initial.progress,run.progress);
  const missingOrigin=await fetch(advanceUrl,{method:"POST",headers:{...getHeaders,"content-type":"application/json"},body:"{}"});assert.equal(missingOrigin.status,403);assert.equal((await missingOrigin.json()).error,"طلب غير صالح");
  const foreignOrigin=await fetch(advanceUrl,{method:"POST",headers:{...getHeaders,origin:"https://foreign.example","content-type":"application/json"},body:"{}"});assert.equal(foreignOrigin.status,403);
  const unchanged=await (await fetch(statusUrl,{headers:getHeaders})).json();assert.equal(unchanged.phase,initial.phase);assert.deepEqual(unchanged.progress,initial.progress);
  for(let i=0;i<20&&run.state!=="completed";i++){
    const advance=await fetch(advanceUrl,{method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}"});assert.equal(advance.status,200);run=await advance.json();
    const status=await fetch(statusUrl,{headers:getHeaders});assert.equal(status.status,200);const observed=await status.json();assert.equal(observed.state,run.state);assert.deepEqual(observed.progress,run.progress);
  }assert.equal(run.state,"completed");assert.equal(run.counts.products.processed,2);
  console.log(JSON.stringify({wasmPath:`${process.cwd()}/.next/standalone/node_modules/sql.js/dist/sql-wasm.wasm`,wasmExists:true,fixtureOpened:true,httpChunkPreview:true,httpActualImport:true,importState:run.state,counts:{products:2,warehouses:1}}));
} catch(error) { throw new Error(`${error.message}\nProduction server logs:\n${logs}`); }
finally {server.kill("SIGTERM");await mongo.stop();}
