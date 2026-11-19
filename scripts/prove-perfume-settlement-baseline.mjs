import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";

assert(process.env.CI==="true"&&process.env.GITHUB_ACTIONS==="true"&&process.platform==="win32",
  "Run this proof only in the isolated GitHub Windows job.");
const baseline="47bc95d38f31eeb2d2afbc06bce1803ea06b2358";
const expectedTree="0c333afcf981c33994b7c0919fc54b42566fe9e2";
const root=process.cwd();
const files=["app/perfume-invoice-commands.ts","app/perfume-operation-guards.ts","app/perfume-remainder-sale.ts","app/perfume-split-reversal.ts"];
function git(args){
  const result=spawnSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:4*1024*1024,timeout:120000});
  assert.equal(result.status,0,result.stderr||result.error?.message||"Git source lookup failed");
  return result.stdout;
}
git(["fetch","--no-tags","--depth=1","origin",baseline]);
assert.equal(git(["show","-s","--format=%T",baseline]).trim(),expectedTree);
const snapshots=new Map(await Promise.all(files.map(async file=>[file,await readFile(path.join(root,file))])));
try{
  for(const file of files)await writeFile(path.join(root,file),git(["show",`${baseline}:${file}`]));
  const result=spawnSync(process.execPath,["--import","tsx","--test","tests/perfume-settlement-reopen.test.mjs"],{
    cwd:root,env:{...process.env,PERFUME_SETTLEMENT_EXPECT_OLD:"1"},stdio:"inherit",windowsHide:true,timeout:120000,
  });
  assert.equal(result.status,0,result.error?.message||"The original code did not reproduce the settled-lot return blocker.");
  console.log("BEFORE FIX: reproduced a settled-lot return blocked by the exact previous implementation.");
}finally{
  for(const[file,bytes]of snapshots){await writeFile(path.join(root,file),bytes);assert.deepEqual(await readFile(path.join(root,file)),bytes);}
  git(["diff","--exit-code","--",...files]);
  console.log("Restored the exact candidate source before UI, full-suite and packaged checks.");
}
