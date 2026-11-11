import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32") {
  throw new Error("This smoke check runs only in GitHub Actions on Windows.");
}
assert(process.execArgv.includes("--test") || process.env.NODE_TEST_CONTEXT !== undefined, "Use the Node test runner for this CI-only fixture.");

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(source, "test-output", "payroll-ui");
const temporaryRoot = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(temporaryRoot, "alkarna-payroll-ui-"));
assert.equal(path.dirname(profile), temporaryRoot);
for (const name of ["data", "licensing", "chrome"]) fs.mkdirSync(path.join(profile, name));
fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "test", ALKARNA_DESKTOP: "1", ALKARNA_USER_DATA: profile,
  ALKARNA_DATABASE_PATH: path.join(profile, "data", "audit.sqlite"),
  ALKARNA_LICENSE_STATE_PATH: path.join(profile, "licensing", "state.json"),
  ALKARNA_LICENSE_DISABLE_REGISTRY: "1", ALKARNA_TEST_LICENSE_BYPASS: "1",
});
delete process.env.ALKARNA_DESKTOP_TOKEN;
delete process.env.ALKARNA_TEST_DEVICE_ID;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("Timed out waiting for " + description);
}
const result = {
  status: "running", mode: "Actual React employee, perfume, parties and party-ledger report components with real application routes in an isolated CI profile",
  ciOnly: true, licenseBypass: "test-only CI", screenshots: [], checkpoints: [],
};
let database, closeDatabase, server, chrome, cdp, browserBundle;

async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(), errors = [], consoleMessages = [], network = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled") consoleMessages.push({type:message.params.type,args:message.params.args.map(argument=>argument.value??argument.description)});
    if (message.method === "Network.responseReceived") network.push({url:message.params.response.url,status:message.params.response.status});
    if (message.method === "Network.loadingFailed") network.push({requestId:message.params.requestId,error:message.params.errorText});
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout " + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    call, errors, consoleMessages, network, close: () => socket.close(),
    async evaluate(expression) {
      const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    },
  };
}

async function main() {
  const sqlite = await import("../lib/sqlite.ts");
  closeDatabase = sqlite.closeDatabase;
  database = sqlite.initializeDatabase();
  assert.equal(await database.collection("employees").countDocuments(), 0);
  assert.equal(await database.collection("users").countDocuments(), 0, "Fresh CI profile uses the application's standard local principal");
  result.authentication = "Standard local principal on a fresh profile without users";
  const account = await database.collection("paymentAccounts").findOne({ code: "cash" });
  await database.collection("paymentAccounts").updateOne({ id: account.id }, { $set: { balance: 1000, openingBalance: 1000, isActive: true } });
  const { execute, POST } = await import("../app/api/command/route.ts");
  const { GET } = await import("../app/api/bootstrap/route.ts");
  const { GET: historyGET } = await import("../app/api/history/route.ts");
  const { GET: reportsGET } = await import("../app/api/reports/route.ts");
  const bootstrapCheck = await GET(new Request("http://127.0.0.1:3219/api/bootstrap"));
  assert.equal(bootstrapCheck.status, 200, await bootstrapCheck.text());
  const date = new Date().toISOString().slice(0, 10);
  const employeeId = await database.transaction(session => execute(database, session, {
    type: "employee.create", name: "عامل فحص الواجهة", phone: "00000000", amount: 100,
    startDate: date, intervalMonths: 12, entitlement: "beginning",
  }));

  const entry = `
    import React,{useCallback,useEffect,useRef,useState} from "react";
    import{createRoot}from"react-dom/client";
    import EmployeesPage from "./app/employees-page";
    import DecantInvoicesPage from "./app/decant-invoices-page";
    import{Parties,PartyPage,Reports}from"./app/conta-app";
    import{LocaleProvider,useI18n}from"./app/i18n/provider";
    import{ConfirmationProvider,useAppConfirm}from"./app/app-confirm";
    import{requestEditorReplacement}from"./app/editor-replacement";
    import{finishSuccessfulCommand}from"./app/command-lifecycle";
    import{tr}from"./app/i18n/messages";
    function Shell(){
      const[data,setData]=useState(null),[sourceId,setSourceId]=useState(${JSON.stringify(employeeId)}),[view,setView]=useState("employees");
      const[selectedPartyId,setSelectedPartyId]=useState(null),editorGuard=useRef(null),pending=useRef(false);
      const{setLocale}=useI18n(),confirmAction=useAppConfirm();
      const register=useCallback(guard=>{editorGuard.current=guard},[]);
      const prepare=()=>requestEditorReplacement({hasPendingCommands:()=>pending.current,getGuard:()=>editorGuard.current,confirmDiscard:()=>confirmAction({message:tr("لديك تعديلات غير محفوظة. هل تريد تجاهلها والانتقال؟")}),onPending:()=>{window.__smokePendingBlocked=true}});
      const refresh=async()=>{const response=await fetch("/api/bootstrap"),value=await response.json();if(!response.ok)throw new Error(value.error||"Bootstrap failed");setData(value)};
      useEffect(()=>{void refresh().catch(error=>{window.__smokeError=error.stack;console.error(error)})},[]);
      useEffect(()=>{
        window.__smokeSetView=async next=>{if(!await prepare())return false;await refresh();setView(next);document.getElementById("root").className="app-shell section-"+(next==="perfume"?"decantInvoices":next==="party-ledger"?"reports":next==="party-detail"?"customers":next);return true};
        window.__smokeSetLocale=setLocale;
        return()=>{delete window.__smokeSetView;delete window.__smokeSetLocale};
      },[setLocale]);
      const run=async(body,_message,afterSuccess)=>{
        window.__payrollBusy=true;pending.current=true;
        try{
          const response=await fetch("/api/command",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)});
          const value=await response.json();if(!response.ok)throw new Error(value.error);
          await finishSuccessfulCommand(afterSuccess,refresh);
          window.__lastPayrollResult=value;return value.id;
        }finally{window.__payrollBusy=false;pending.current=false}
      };
      if(!data)return <p>Loading</p>;
      const openDoc=id=>{window.__openedPayrollDocument=id};
      if(view==="customers"||view==="suppliers")return <Parties key={view} partyType={view==="customers"?"customer":"supplier"} data={data} run={run} openParty={party=>{window.__openedParty=party.id;setSelectedPartyId(party.id);setView("party-detail")}} canEdit canDelete registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      if(view==="party-detail"){const party=data.parties.find(row=>row.id===selectedPartyId);return party?<PartyPage key={party.id} party={party} data={data} run={run} openDoc={openDoc} editRequest={null} clearEditRequest={()=>{}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>:<p>Missing synthetic party</p>}
      if(view==="party-ledger")return <Reports data={data} openDoc={openDoc} openSource={target=>{window.__openedReportSource=target}} type="party-ledger" sourceRequest={null} clearSourceRequest={()=>{}}/>;
      return view==="perfume"?<DecantInvoicesPage data={data} run={run} openDoc={id=>{window.__openedPerfumeDocument=id}} requestPrint={id=>{window.__printedPerfumeDocument=id}}/>:<EmployeesPage data={data} run={run} openDoc={id=>{window.__openedPayrollDocument=id}} sourceId={sourceId} clearSource={()=>setSourceId(null)} registerEditorGuard={register}/>;
    }
    createRoot(document.getElementById("root")).render(<LocaleProvider initialLocale="ar"><ConfirmationProvider><Shell/></ConfirmationProvider></LocaleProvider>);
  `;
  const bundled = await build({
    absWorkingDir: source, stdin: { contents: entry, resolveDir: source, loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    plugins:[{name:"ci-only-component-exports",setup(builder){builder.onLoad({filter:/[\\/]app[\\/]conta-app\.tsx$/},args=>({contents:fs.readFileSync(args.path,"utf8")+"\nexport { Parties, PartyPage, Reports };\n",loader:"tsx",resolveDir:path.dirname(args.path)}))}}],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  const script = bundled.outputFiles[0].contents;
  browserBundle=script;
  const styles=[...fs.readFileSync(path.join(source,"app","layout.tsx"),"utf8").matchAll(/^import "\.\/([^"\r\n]+\.css)";/gm)].map(match=>match[1]);
  assert(styles.includes("globals.css")&&styles.includes("perfume-context.css"),"Use the actual application theme imports");
  const css = styles.map(name=>fs.readFileSync(path.join(source,"app",name),"utf8")).join("\n").replace(/^[ \t]*@import[^\r\n]*;[ \t]*(?:\r?\n|$)/gm, "");
  server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/app.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return; }
      if (request.url === "/app.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{display:block;margin:0}#root{display:block;height:100vh}.employees-workspace{height:100%}</style><div id="root" class="app-shell section-employees"></div><script src="/app.js"></script></html>');
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 65536) throw new Error("CI request too large");
        chunks.push(chunk);
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value]));
      const webRequest = new Request("http://" + request.headers.host + request.url, {
        method: request.method, headers,
        ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      const value = request.url === "/api/bootstrap" ? await GET(webRequest) :
        request.url.startsWith("/api/history?") ? await historyGET(webRequest) :
        request.url.startsWith("/api/reports?") ? await reportsGET(webRequest) :
        request.url === "/api/command" ? await POST(webRequest) : new Response("Not found", { status: 404 });
      response.writeHead(value.status, Object.fromEntries(value.headers));
      response.end(Buffer.from(await value.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const executable = [process.env.CHROME_PATH, path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe")].find(file => file && fs.existsSync(file));
  assert(executable, "Chrome is installed on the Windows runner");
  chrome = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + path.join(profile, "chrome"), "about:blank"],
  { windowsHide: true, stdio: "ignore" });
  const portFile = path.join(profile, "chrome", "DevToolsActivePort");
  await until(() => fs.existsSync(portFile), "Chrome debugging port");
  const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0];
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  cdp = await connectCdp(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Network.enable");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.navigate", { url: base });
  await until(() => cdp.evaluate('Boolean(document.querySelector(".employee-payment-panel"))'), "employee account");
  await cdp.evaluate(`
    window.__payrollUi={
      fill(label,value){
        const row=[...document.querySelectorAll(".employee-payment-panel label")].find(element=>element.firstChild.textContent.trim()===label);
        if(!row)throw new Error("Missing field "+label);
        const field=row.querySelector("input,select");
        const prototype=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,value);
        field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));
      },
      submit(){document.querySelector(".employee-payment-panel button.primary").click()},
      action(number,label){
        const row=[...document.querySelectorAll(".employees-history tbody tr")].find(element=>element.querySelector(".source-link")?.title===number);
        const button=[...row.querySelectorAll("button[aria-label]")].find(element=>element.getAttribute("aria-label").startsWith(label+" "));
        if(!button)throw new Error("Missing history action "+label);button.click();
      }
    };
  `);
  const state = async () => ({
    employee: await database.collection("employees").findOne({ id: employeeId }),
    account: await database.collection("paymentAccounts").findOne({ id: account.id }),
    documents: await database.collection("documents").find({ employeeId }).toArray(),
  });
  async function expectState(balance, cash) {
    await until(async () => {
      const current = await state();
      return current.employee.balance === balance && current.account.balance === cash &&
        await cdp.evaluate('!window.__payrollBusy && document.querySelector(".employee-balance strong")?.textContent.includes(' + JSON.stringify(String(Math.abs(balance))) + ')');
    }, "employee balance" + balance + " and cash" + cash);
  }
  const fill = (label, value) => cdp.evaluate("window.__payrollUi.fill(" + JSON.stringify(label) + "," + JSON.stringify(String(value)) + ")");
  async function screenshot(name, width) {
    await cdp.call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal(await cdp.evaluate("document.documentElement.scrollWidth>innerWidth+1"),false,"No page-level horizontal overflow");
    if(width<=1000&&await cdp.evaluate('Boolean(document.querySelector(".decant-invoice-modebar"))')) {
      const modebar=await cdp.evaluate(`(()=>{
        const bar=document.querySelector(".decant-invoice-modebar").getBoundingClientRect(),tabs=document.querySelector(".decant-invoice-mode-tabs").getBoundingClientRect(),help=document.querySelector(".decant-invoice-mode-help"),box=help.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(help);
        return{width:innerWidth,bar:{left:bar.left,right:bar.right,bottom:bar.bottom},tabsBottom:tabs.bottom,help:{left:box.left,right:box.right,top:box.top,bottom:box.bottom},textInside:[...range.getClientRects()].every(rect=>rect.left>=box.left-1&&rect.right<=box.right+1&&rect.top>=box.top-1&&rect.bottom<=box.bottom+1),contentFits:help.scrollWidth<=help.clientWidth+1&&help.scrollHeight<=help.clientHeight+1};
      })()`);
      assert(modebar.help.top>=modebar.tabsBottom-1,"Narrow perfume mode help occupies its own row below all tabs");
      assert(modebar.help.left>=Math.max(0,modebar.bar.left)-1&&modebar.help.right<=Math.min(width,modebar.bar.right)+1&&modebar.help.bottom<=modebar.bar.bottom+1,"Mode help stays inside its bar and viewport");
      assert(modebar.textInside&&modebar.contentFits,"Mode help text wraps completely without clipping");
      (result.modebarLayouts??=[]).push({name,...modebar});
    }
    const capture = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(capture.data, "base64"));
    result.screenshots.push(name + ".png");
  }
  async function employeeScreenshot(name,width) {
    await screenshot(name,width);
    const layout = await cdp.evaluate(`(()=>{
      const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom}};
      return{list:box(".employees-list"),history:box(".employees-history"),account:box(".employees-account"),overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.equal(layout.overflow, false);
    if (width === 1280) {
      assert(layout.history.y >= layout.list.bottom - 1);
      assert(layout.history.right <= layout.account.x + 1 || layout.account.right <= layout.history.x + 1);
    }
  }
  await expectState(100, 1000);
  await cdp.evaluate('document.querySelector(".employee-payment-panel select").focus()');
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert(await cdp.evaluate('document.activeElement===document.querySelector(".employee-payment-panel input[type=number]")'));
  result.checkpoints.push("Keyboard Tab moves from movement direction to amount");
  await fill("نوع الحركة", "withdraw");
  await fill("المبلغ", 150);
  await fill("وسيلة الدفع", account.id);
  await cdp.evaluate("window.__payrollUi.submit()");
  await expectState(-50, 850);
  assert(await cdp.evaluate('document.querySelector(".employee-balance").textContent.includes("مستحق على العامل")'));
  const withdrawal = (await state()).documents.find(document => document.kind === "employee-payment");
  await employeeScreenshot("withdrawal-1280", 1280);
  result.checkpoints.push("Actual UI withdrawal150 exceeds accrued100, cash850 and signed worker balance-50");
  await fill("نوع الحركة", "deposit");
  await fill("المبلغ", 30);
  await fill("وسيلة الدفع", account.id);
  await cdp.evaluate("window.__payrollUi.submit()");
  await expectState(-20, 880);
  const deposit = (await state()).documents.find(document => document.employeePaymentDirection === "deposit");
  assert(deposit);
  await employeeScreenshot("deposit-760", 760);
  result.checkpoints.push("Actual UI deposit30 increases cash and worker balance");
  await fill("المبلغ", 7);
  await cdp.evaluate("window.__payrollUi.action(" + JSON.stringify(deposit.number) + ',"تعديل")');
  await until(() => cdp.evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "unsaved editor confirmation");
  await cdp.evaluate('document.querySelector(".app-confirm-actions button:last-child").click()');
  assert.equal(await cdp.evaluate('document.querySelector(".employee-payment-panel input[type=number]").value'), "7");
  await expectState(-20, 880);
  await cdp.evaluate("window.__payrollUi.action(" + JSON.stringify(deposit.number) + ',"تعديل")');
  await until(() => cdp.evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "confirmed editor replacement");
  await cdp.evaluate('document.querySelector(".app-confirm-actions button").click()');
  await until(() => cdp.evaluate('document.querySelector(".employee-payment-panel select")?.value==="deposit"'), "deposit edit direction");
  result.checkpoints.push("Canceling the unsaved-editor dialog keeps the draft and cash, confirming opens the history edit");
  await fill("المبلغ", 50);
  await fill("سبب التعديل", "CI correction");
  await cdp.evaluate("window.__payrollUi.submit()");
  await expectState(0, 900);
  const edit = (await state()).documents.find(document => document.id === deposit.id);
  assert.equal(edit.revision, 1);
  result.checkpoints.push("History edits the deposit in place with its saved direction and exact cash delta");
  for (const [document, balance, cash] of [[edit, -50, 850], [withdrawal, 100, 1000]]) {
    await cdp.evaluate("window.__payrollUi.action(" + JSON.stringify(document.number) + ',"إلغاء السند")');
    await until(() => cdp.evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'), "void confirmation");
    await cdp.evaluate('document.querySelector(".app-confirm-actions button").click()');
    await expectState(balance, cash);
    const saved = (await state()).documents.find(row => row.id === document.id);
    assert.equal(saved.status, "voided");
  }
  await employeeScreenshot("after-voids-1280", 1280);
  result.checkpoints.push("Both void actions restore their original effects once, leaving accrual100 and cash1000");
  const final = await state();
  assert.equal(final.documents.filter(document => document.kind === "employee-accrual" && document.status === "posted").length, 1);
  assert.equal(final.documents.filter(document => document.kind === "employee-payment" && document.status === "posted").length, 0);
  const command=async body=>{
    const response=await fetch(base+"/api/command",{method:"POST",headers:{"content-type":"application/json",Origin:base,"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)}),value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));return value.id;
  };
  await perfumeScenarios({database,command,screenshot});
  await cdp.evaluate('window.__smokeSetLocale("ar")');
  await until(()=>cdp.evaluate('document.documentElement.lang==="ar"'),"Arabic party scenario locale");
  const {runPartiesReportScenarios}=await import("./parties-ui-scenarios.mjs");
  result.partyReports=await runPartiesReportScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.partyReports.checkpoints);
  assert.deepEqual(cdp.errors, []);
  result.status = "passed";
}

async function perfumeScenarios({database,command,screenshot}) {
  const warehouse=await database.collection("warehouses").findOne({isArchived:{$ne:true}});
  assert(warehouse,"Synthetic profile has a warehouse");
  const warehouseId=String(warehouse._id??warehouse.id);
  const sourceId=await command({type:"product.create",name:"عطر اختبار الدفعات",pieceCost:1000,piecePrice:1500,openingStock:2,openingWarehouseId:warehouseId});
  const oldConversion=await command({type:"perfume-split.post",sourceProductId:sourceId,warehouseId,volumeMl:100,salePrice:150,priceBasisMl:10});
  const old=await database.collection("documents").findOne({id:oldConversion});
  await command({type:"perfume-lot-consume.post",decantProductId:old.decantProductId,lotId:old.perfumeLotId,warehouseId,quantity:100,reasonCode:"samples",reason:"Synthetic exhausted batch"});
  const newConversion=await command({type:"perfume-split.post",sourceProductId:sourceId,warehouseId,volumeMl:100,salePrice:150,priceBasisMl:10});
  const current=await database.collection("documents").findOne({id:newConversion});
  const openingSourceId=await command({type:"product.create",name:"عطر افتتاحي تجريبي",pieceCost:1000,piecePrice:1500,openingStock:0});
  const beforeBrowsing=await Promise.all(["products","documents","stockMovements","financialMovements","paymentAccounts"].map(name=>database.collection(name).find().toArray()));
  await cdp.call("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.evaluate('window.__smokeSetView("perfume")');
  await until(()=>cdp.evaluate('Boolean(document.querySelector(".decant-invoices-hub"))'),"real perfume invoice hub");
  await cdp.evaluate('document.querySelectorAll(".decant-invoice-mode-tabs [role=tab]")[2].click()');
  await until(()=>cdp.evaluate('Boolean(document.querySelector(".pm-register .pm-check input[type=checkbox]"))'),"batch view control");
  const batchIds=()=>cdp.evaluate('Array.from(document.querySelectorAll(".pm-register:not(.pm-stock-register) tbody td[title]")).map(td=>td.title.split(" · ").at(-1))');
  await until(async()=>JSON.stringify(await batchIds())===JSON.stringify([current.perfumeLotId]),"open batches only");
  await screenshot("perfume-open-batches-1280",1280);
  await cdp.evaluate('document.querySelector(".pm-register .pm-check input[type=checkbox]").click()');
  await until(async()=>JSON.stringify(await batchIds())===JSON.stringify([old.perfumeLotId]),"closed batches only");
  await screenshot("perfume-closed-batches-1280",1280);
  await cdp.evaluate('document.querySelector(".pm-register .pm-check input[type=checkbox]").click()');
  await until(async()=>JSON.stringify(await batchIds())===JSON.stringify([current.perfumeLotId]),"return to open batches only");
  assert.deepEqual(await Promise.all(["products","documents","stockMovements","financialMovements","paymentAccounts"].map(name=>database.collection(name).find().toArray())),beforeBrowsing,"Batch filtering is read-only");
  result.checkpoints.push("Real batch checkbox switches exclusively between an exhausted lot and the latest open100ml lot without changing data");

  await cdp.evaluate('document.querySelectorAll(".decant-invoice-mode-tabs [role=tab]")[3].click()');
  await until(()=>cdp.evaluate('Boolean(document.querySelector(".pm-opening-grid"))'),"compact opening form");
  await cdp.evaluate(`
    window.__perfumeUi={
      fill(label,value){
        const row=[...document.querySelectorAll(".pm-fields label")].find(element=>element.firstChild.textContent.trim()===label);
        if(!row)throw new Error("Missing perfume field "+label);
        const field=row.querySelector("input,select");
        const prototype=field.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype,"value").set.call(field,value);
        field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));
      },
      search(value){
        const input=document.querySelector(".pm-editor .perfume-product-search input");input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);
        input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));
      }
    };
  `);
  await cdp.evaluate('window.__perfumeUi.search("عطر افتتاحي تجريبي")');
  await until(()=>cdp.evaluate('Array.from(document.querySelectorAll(".pm-editor .perfume-product-results [role=option]")).some(button=>button.textContent.includes("عطر افتتاحي تجريبي"))'),"opening perfume search");
  await cdp.evaluate('Array.from(document.querySelectorAll(".pm-editor .perfume-product-results [role=option]")).find(button=>button.textContent.includes("عطر افتتاحي تجريبي")).click()');
  for(const [label,value] of [["حجم العطر الأصلي بالمل",100],["المتبقي الفعلي بالمل",40],["سعر البيع للتقسيمة",150]]) {
    await cdp.evaluate("window.__perfumeUi.fill("+JSON.stringify(label)+","+JSON.stringify(String(value))+")");
  }
  await until(()=>cdp.evaluate('document.querySelector(".pm-opening-value input").value.includes("400")'),"automatic opening value400");
  const openingLayout=await cdp.evaluate(`(()=>{
    const fields=[...document.querySelectorAll(".pm-opening-grid label")].map(label=>{const r=label.getBoundingClientRect();return{y:r.y,right:r.right,x:r.x,width:r.width}});
    return{fields,overflow:document.documentElement.scrollWidth>innerWidth+1};
  })()`);
  assert.equal(openingLayout.fields.length,4);
  assert(Math.abs(openingLayout.fields[0].y-openingLayout.fields[1].y)<2,"Original and remaining volumes share a compact row");
  assert(Math.abs(openingLayout.fields[2].y-openingLayout.fields[3].y)<2,"Sale price and computed value share a compact row");
  assert.equal(openingLayout.overflow,false);
  await screenshot("perfume-opening-form-1280",1280);
  await screenshot("perfume-opening-form-760",760);
  await cdp.evaluate('document.querySelector(".pm-form-actions button[type=submit]").click()');
  let opening;
  await until(async()=>{opening=await database.collection("documents").findOne({sourceProductId:openingSourceId,perfumeStockOperationType:"opening",status:"posted"});return Boolean(opening)},"opening committed through actual UI");
  assert.equal(opening.stockDelta,40);
  assert.equal(opening.bookValueAfter,400);
  assert.equal(opening.openingBottleCost,1000);
  assert.equal((await database.collection("products").findOne({id:openingSourceId})).openingStock,0);
  const accountBefore=beforeBrowsing[4].find(account=>account.code==="cash"),accountAfter=await database.collection("paymentAccounts").findOne({id:accountBefore.id});
  assert.equal(accountAfter.balance,accountBefore.balance,"Old-opened declaration does not move cash");
  const transitionSelector='.pm-stock-register tbody tr .pm-stock-transition';
  await until(()=>cdp.evaluate('Boolean(document.querySelector('+JSON.stringify(transitionSelector)+'))'),"opening history through real history API");
  const historyBeforeLocale=await Promise.all(["products","documents","stockMovements","financialMovements","paymentAccounts"].map(name=>database.collection(name).find().toArray()));
  for(const [locale,width] of [["ar",1280],["ar",760],["fr",1280],["fr",760]]) {
    await cdp.evaluate("window.__smokeSetLocale("+JSON.stringify(locale)+")");
    await until(()=>cdp.evaluate("document.documentElement.lang==="+JSON.stringify(locale)),"perfume locale "+locale);
    await cdp.call("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
    const transition=await cdp.evaluate(`(()=>{
      const element=document.querySelector(${JSON.stringify(transitionSelector)}),values=element.querySelectorAll("bdi"),before=values[0].getBoundingClientRect(),after=values[1].getBoundingClientRect();
      return{before:values[0].textContent,after:values[1].textContent,beforeX:before.x,afterRight:after.right,arrow:element.children[1].textContent,dir:document.documentElement.dir};
    })()`);
    assert.equal(transition.before,"0");assert.equal(transition.after,"40");
    assert(transition.beforeX>transition.afterRight,"Before0 remains physically RIGHT of after40 in "+locale);
    assert.equal(transition.arrow,"←");assert.equal(transition.dir,locale==="ar"?"rtl":"ltr");
    await screenshot("perfume-opening-history-"+locale+"-"+width,width);
  }
  assert.deepEqual(await Promise.all(["products","documents","stockMovements","financialMovements","paymentAccounts"].map(name=>database.collection(name).find().toArray())),historyBeforeLocale,"Locale/layout changes preserve all business records");
  result.checkpoints.push("Actual opening UI saves40of100ml at cost1000/value400 without cash, then shows before0 RIGHT/left-arrow/after40 LEFT at1280 and760 in Arabic and French");
}

try {
  await main();
} catch (error) {
  result.status = "failed";
  result.error = error.stack;
  result.browserErrors = cdp?.errors ?? [];
  result.browserConsole = cdp?.consoleMessages ?? [];
  result.browserNetwork = cdp?.network ?? [];
  if(browserBundle)fs.writeFileSync(path.join(output,"bundle.js"),browserBundle);
  if (cdp) {
    try {
      const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(output, "failure.png"), Buffer.from(screenshot.data, "base64"));
      fs.writeFileSync(path.join(output, "failure.html"), await cdp.evaluate("document.documentElement.outerHTML"));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode === null) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (closeDatabase) closeDatabase();
  const resolved = path.resolve(profile);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert(path.basename(resolved).startsWith("alkarna-payroll-ui-"));
  try {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    result.profileRemoved = true;
  } catch (error) {
    result.profileRemoved = false;
    result.cleanupError = error.message;
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
