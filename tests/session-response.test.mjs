import assert from "node:assert/strict";
import test from "node:test";
import { readApiResponse, redirectExpiredSession } from "../app/api-response.ts";
import { POST as logout } from "../app/api/auth/logout/route.ts";

test("authenticated API failures redirect only for a genuine missing session", async t => {
  const visits=[];
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,writable:true,value:{location:{pathname:"/",assign:route=>visits.push(route)}}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,"window",previous);else delete globalThis.window;});
  for(const status of [402,403,408,500]){
    await assert.rejects(readApiResponse(Response.json({error:"Synthetic failure"},{status})),/Synthetic failure/);
  }
  assert.deepEqual(visits,[]);
  await assert.rejects(readApiResponse(Response.json({error:"Session missing"},{status:401})),/Session missing/);
  assert.deepEqual(visits,["/login"]);
  window.location.pathname="/login";
  redirectExpiredSession(new Response(null,{status:401}));
  assert.deepEqual(visits,["/login"],"Rejected sign-in does not cause a navigation loop");
});

test("desktop logout clears the same session cookie over its loopback HTTP origin", async () => {
  const previousDesktop=process.env.ALKARNA_DESKTOP,previousMode=process.env.NODE_ENV;
  process.env.ALKARNA_DESKTOP="1";
  process.env.NODE_ENV="production";
  try{
    const response=await logout(new Request("http://127.0.0.1:3219/api/auth/logout",{method:"POST",headers:{origin:"http://127.0.0.1:3219",host:"127.0.0.1:3219"}}));
    assert.equal(response.status,303);
    assert.equal(response.headers.get("location"),"/login");
    assert.equal(response.headers.get("set-cookie"),"conta_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  }finally{
    if(previousDesktop===undefined)delete process.env.ALKARNA_DESKTOP;else process.env.ALKARNA_DESKTOP=previousDesktop;
    if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode;
  }
});
