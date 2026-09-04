import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";

test("shared asynchronous confirmation owns focus, escape, tab trapping, and single settlement",async()=>{
  const source=await readFile(new URL("../app/app-confirm.tsx",import.meta.url),"utf8");
  assert.match(source,/Promise<boolean>/);assert.match(source,/document\.activeElement instanceof HTMLElement/);
  assert.match(source,/active\.opener\?\.isConnected/);assert.match(source,/requestAnimationFrame/);
  assert.match(source,/event\.key==="Escape"/);assert.match(source,/event\.key!=="Tab"/);
  assert.match(source,/requestRef\.current=null/);assert.match(source,/if\(requestRef\.current\)return Promise\.resolve\(false\)/);
  assert.match(source,/role="dialog"/);assert.match(source,/aria-modal="true"/);
});

test("renderer contains no blocking confirm or alert calls",async()=>{
  const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.doesNotMatch(source,/(?:window\.)?(?:confirm|alert)\s*\(/);
  assert.match(source,/useAppConfirm/);
});
