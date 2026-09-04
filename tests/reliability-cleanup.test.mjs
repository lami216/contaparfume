import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
const app=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),route=await readFile(new URL("../app/api/command/route.ts",import.meta.url),"utf8"),sqlite=await readFile(new URL("../lib/sqlite.ts",import.meta.url),"utf8");
test("SearchableSelect separates selected and transient highlight",()=>{const select=app.slice(app.indexOf("function SearchableSelect"),app.indexOf("function ProductSearchPicker"));assert.match(select,/useState<number\|null>\(null\)/);assert.match(select,/option\.value === value && "selected"/);assert.match(select,/highlightedIndex === index && "highlighted"/);assert.match(select,/highlightedIndex !== null && matches\[highlightedIndex\]/);assert.doesNotMatch(select,/setActive\(0\)|index === active|\? "active"/)});
test("command client is in-flight single-flight and sends one idempotency identity",()=>{assert.match(app,/inFlightCommands = useRef\(new Map/);assert.match(app,/existing=inFlightCommands\.current\.get\(fingerprint\)/);assert.match(app,/"Idempotency-Key":crypto\.randomUUID\(\)/);assert.match(app,/finally\{inFlightCommands\.current\.delete\(fingerprint\)\}/)});
test("server receipt claim and business mutation share a transaction",()=>{assert.match(route,/receipts\.insertOne\([^;]+\{session\}/);assert.match(route,/result=await execute\(db,session,body\)/);assert.match(route,/status:"committed",result:response/);assert.match(route,/مفتاح العملية مستخدم لطلب مختلف/);assert.match(route,/العملية قيد التنفيذ/);assert.match(sqlite,/DELETE FROM command_receipts/);assert.match(sqlite,/cleanupExpiredRecords/)});
test("adjustments reject a no-op before creating ADJ",()=>{
  const block=route.slice(route.indexOf('if (type === "adjustment.post")'),route.indexOf('if (type === "party-cash.post")'));
  assert.match(block,/effectiveInput=input\.filter/);
  assert.match(block,/لا يوجد تغيير في المخزون لاعتماده/);
  assert.ok(block.indexOf("effectiveInput")<block.indexOf('baseDocument("adjustment", "ADJ")'));
});
test("normal first-open ranges use the local business day",()=>{assert.match(app,/function useBankScope\(\)\{const today=localBusinessDay\(\)/);assert.match(app,/function PartyPage[\s\S]*?const today=localBusinessDay\(\),\[from,setFrom\]=useState\(today\),\[to,setTo\]=useState\(today\)/);assert.match(app,/function Warehouses[\s\S]*?const today=localBusinessDay\(\),\[draftFrom,setDraftFrom\]=useState\(today\),\[draftTo,setDraftTo\]=useState\(today\)/);assert.match(app,/function Reports[\s\S]*?const today=localBusinessDay\(\),\[draftFrom,setDraftFrom\]=useState\(today\),\[draftTo,setDraftTo\]=useState\(today\)/);assert.match(app,/useState\(dateFilter \? today : ""\)/)});
