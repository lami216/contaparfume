import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";
import { inflateRawSync } from "node:zlib";
import { assertControlBounds, captureControlLayouts } from "./ui-control-bounds.mjs";

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
  status: "running", mode: "Actual React employee accounts and opening balances, perfume, parties, expenses, reports and ordinary sale/purchase components with real application routes in an isolated CI profile",
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
    import{Parties,PartyPage,Reports,Expenses,Pos,Purchases,Adjustment,Records,Banks,DocumentDetail}from"./app/conta-app";
    import{LocaleProvider,useI18n}from"./app/i18n/provider";
    import{ConfirmationProvider,useAppConfirm}from"./app/app-confirm";
    import{requestEditorReplacement}from"./app/editor-replacement";
    import{finishSuccessfulCommand}from"./app/command-lifecycle";
    import{tr}from"./app/i18n/messages";
    function Shell(){
      const[data,setData]=useState(null),[sourceId,setSourceId]=useState(${JSON.stringify(employeeId)}),[view,setView]=useState("employees");
      const[selectedPartyId,setSelectedPartyId]=useState(null),[expenseEditId,setExpenseEditId]=useState(null),[statementPreviewId,setStatementPreviewId]=useState(null),[notePerfumeEditId,setNotePerfumeEditId]=useState(null),editorGuard=useRef(null),pending=useRef(false);
      const{setLocale}=useI18n(),confirmAction=useAppConfirm();
      const register=useCallback(guard=>{editorGuard.current=guard},[]);
      const prepare=()=>requestEditorReplacement({hasPendingCommands:()=>pending.current,getGuard:()=>editorGuard.current,confirmDiscard:()=>confirmAction({message:tr("لديك تعديلات غير محفوظة. هل تريد تجاهلها والانتقال؟")}),onPending:()=>{window.__smokePendingBlocked=true}});
      const refresh=async()=>{const response=await fetch("/api/bootstrap"),value=await response.json();if(!response.ok)throw new Error(value.error||"Bootstrap failed");setData(value)};
      useEffect(()=>{void refresh().catch(error=>{window.__smokeError=error.stack;console.error(error)})},[]);
      useEffect(()=>{
        window.__smokeSetView=async next=>{if(!await prepare())return false;await refresh();setStatementPreviewId(null);setView(next);document.getElementById("root").className="app-shell section-"+(next.startsWith("bank-")?"banks":next==="perfume"||next==="perfume-note"?"decantInvoices":["party-ledger","expense-report","overview","stock-report","financial-report"].includes(next)?"reports":next==="party-detail"?"customers":next==="sale"?"pos":next==="purchase"?"purchases":next);return true};
        window.__smokeSetLocale=setLocale;
        window.__smokeOpenNoteDocument=async id=>{if(!await prepare())return false;await refresh();setStatementPreviewId(id);return true};
        window.__smokeEditPerfumeNote=async id=>{if(!await prepare())return false;await refresh();setNotePerfumeEditId(id);setView("perfume-note");document.getElementById("root").className="app-shell section-decantInvoices";return true};
        window.__smokeEditExpense=async id=>{if(!await prepare())return false;await refresh();setView("expenses");setExpenseEditId(id);document.getElementById("root").className="app-shell section-expenses";return true};
        return()=>{delete window.__smokeSetView;delete window.__smokeSetLocale;delete window.__smokeEditExpense;delete window.__smokeOpenNoteDocument;delete window.__smokeEditPerfumeNote};
      },[setLocale]);
      const run=async(body,_message,afterSuccess)=>{
        window.__smokeCommandCount=(window.__smokeCommandCount||0)+1;
        window.__payrollBusy=true;pending.current=true;
        try{
          const response=await fetch("/api/command",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)});
          const value=await response.json();if(!response.ok){window.__smokeLastError=value;throw Object.assign(new Error(value.error),{payload:value,status:response.status})}
          await finishSuccessfulCommand(afterSuccess,refresh);
          window.__lastPayrollResult=value;return value.id;
        }finally{window.__payrollBusy=false;pending.current=false}
      };
      if(!data)return <p>Loading</p>;
      const openDoc=id=>{window.__openedPayrollDocument=id;if(window.__smokeNotesReadMode)setStatementPreviewId(id)};
      const statementDocument=data.documents.find(row=>row.id===statementPreviewId);
      if(statementDocument)return <DocumentDetail document={statementDocument} data={data} close={()=>setStatementPreviewId(null)}/>;
      if(view==="bank-adjustment"||view==="bank-movements")return <Banks data={data} run={run} openDoc={id=>{window.__openedPayrollDocument=id;setStatementPreviewId(id)}} openSource={target=>{window.__openedReportSource=target}} tab={view==="bank-adjustment"?"adjustment":"movements"} sourceRequest={null} clearSourceRequest={()=>{}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      if(view==="financial-report")return <Reports data={data} openDoc={openDoc} openSource={target=>{window.__openedReportSource=target}} type="financial" sourceRequest={null} clearSourceRequest={()=>{}}/>;
      if(view==="records")return <Records data={data} openDoc={openDoc}/>;
      if(view==="stock-report")return <Reports data={data} openDoc={openDoc} openSource={target=>{window.__openedReportSource=target}} type="stock" sourceRequest={null} clearSourceRequest={()=>{}}/>;
      if(view==="adjustments")return <Adjustment data={data} run={run} openDoc={openDoc} openSource={id=>{window.__openedStockSource=id}} openOpeningSource={id=>{window.__openedOpeningProduct=id}} openProductMovements={id=>{window.__openedProductMovements=id}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      if(view==="customers"||view==="suppliers")return <Parties key={view} partyType={view==="customers"?"customer":"supplier"} data={data} run={run} openParty={party=>{window.__openedParty=party.id;setSelectedPartyId(party.id);setView("party-detail")}} canEdit canDelete registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      if(view==="party-detail"){const party=data.parties.find(row=>row.id===selectedPartyId);return party?<PartyPage key={party.id} party={party} data={data} run={run} openDoc={openDoc} editRequest={null} clearEditRequest={()=>{}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>:<p>Missing synthetic party</p>}
      if(view==="party-ledger")return <Reports data={data} openDoc={openDoc} openSource={target=>{window.__openedReportSource=target}} type="party-ledger" sourceRequest={null} clearSourceRequest={()=>{}}/>;
      if(view==="expenses")return <Expenses data={data} run={run} openDoc={openDoc} editRequest={expenseEditId} clearEditRequest={()=>setExpenseEditId(null)} registerEditorGuard={register} canEdit canDelete/>;
      if(view==="expense-report"||view==="overview")return <Reports key={view} data={data} openDoc={openDoc} openSource={target=>{window.__openedReportSource=target}} type={view==="overview"?"overview":"expenses"} sourceRequest={null} clearSourceRequest={()=>{}}/>;
      if(view==="sale")return <Pos data={data} run={run} openDoc={openDoc} editRequest={null} clearEditRequest={()=>{}} requestPrint={id=>{window.__printedInvoice=id}} openStockAdjustment={()=>{throw new Error("Unexpected inventory editor in invoice smoke")}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      if(view==="purchase")return <Purchases data={data} run={run} openDoc={openDoc} editRequest={null} clearEditRequest={()=>{}} requestPrint={id=>{window.__printedInvoice=id}} registerEditorGuard={register} prepareEditorReplacement={prepare}/>;
      return view==="perfume"||view==="perfume-note"?<DecantInvoicesPage data={data} run={run} openDoc={id=>{window.__openedPerfumeDocument=id;if(window.__smokeNotesReadMode)setStatementPreviewId(id)}} requestPrint={id=>{window.__printedPerfumeDocument=id}} editRequest={view==="perfume-note"?notePerfumeEditId:null} clearEditRequest={()=>setNotePerfumeEditId(null)}/>:<EmployeesPage data={data} run={run} openDoc={id=>{window.__openedPayrollDocument=id}} sourceId={sourceId} clearSource={()=>setSourceId(null)} registerEditorGuard={register}/>;
    }
    createRoot(document.getElementById("root")).render(<LocaleProvider initialLocale="ar"><ConfirmationProvider><Shell/></ConfirmationProvider></LocaleProvider>);
  `;
  const bundled = await build({
    absWorkingDir: source, stdin: { contents: entry, resolveDir: source, loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    plugins:[{name:"ci-only-component-exports",setup(builder){builder.onLoad({filter:/[\\/]app[\\/]conta-app\.tsx$/},args=>({contents:fs.readFileSync(args.path,"utf8")+"\nexport { Parties, PartyPage, Reports, Expenses, Pos, Purchases, Adjustment, Records, Banks, DocumentDetail };\n",loader:"tsx",resolveDir:path.dirname(args.path)}))}}],
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
    if(width<=1050&&await cdp.evaluate('Boolean(document.querySelector(".decant-invoice-modebar"))')) {
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
    (result.employeeLayouts??=[]).push(await assertControlBounds({cdp,scope:".employees-toolbar,.employee-card,.employee-payment-panel,.employees-history .employee-actions",name}));
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
  await employeeScreenshot("withdrawal-760", 760);
  await employeeScreenshot("withdrawal-480", 480);
  result.checkpoints.push("Actual UI withdrawal150 exceeds accrued100, cash850 and signed worker balance-50");
  await fill("نوع الحركة", "deposit");
  await fill("المبلغ", 30);
  await fill("وسيلة الدفع", account.id);
  await cdp.evaluate("window.__payrollUi.submit()");
  await expectState(-20, 880);
  const deposit = (await state()).documents.find(document => document.employeePaymentDirection === "deposit");
  assert(deposit);
  await employeeScreenshot("deposit-760", 760);
  await employeeScreenshot("deposit-480", 480);
  await cdp.evaluate('window.__smokeSetLocale("fr")');
  await until(()=>cdp.evaluate('document.documentElement.lang==="fr"'),"French worker movement locale");
  await employeeScreenshot("deposit-fr-480", 480);
  await cdp.evaluate('window.__smokeSetLocale("ar")');
  await until(()=>cdp.evaluate('document.documentElement.lang==="ar"'),"Arabic worker actions restored");
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
  (result.employeeLayouts??=[]).push(...await captureControlLayouts({cdp,screenshot,scope:".employee-payment-panel",name:"worker-movement-edit-ar"}));
  await cdp.evaluate('window.__smokeSetLocale("fr")');
  (result.employeeLayouts??=[]).push(...await captureControlLayouts({cdp,screenshot,scope:".employee-payment-panel",name:"worker-movement-edit-fr",widths:[480]}));
  await cdp.evaluate('window.__smokeSetLocale("ar")');
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
  const {runWorkerProfileScenarios}=await import("./worker-profile-ui-scenarios.mjs");
  result.workerProfiles=await runWorkerProfileScenarios({cdp,database,employeeId,screenshot});
  result.checkpoints.push(...result.workerProfiles.checkpoints);
  const command=async body=>{
    const response=await fetch(base+"/api/command",{method:"POST",headers:{"content-type":"application/json",Origin:base,"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)}),value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));return value.id;
  };
  await perfumeScenarios({database,command,screenshot});
  const {runPerfumeSettlementScenarios}=await import("./perfume-settlement-ui-scenarios.mjs");
  result.perfumeSettlements=await runPerfumeSettlementScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.perfumeSettlements.checkpoints);
  await cdp.evaluate('window.__smokeSetLocale("ar")');
  await until(()=>cdp.evaluate('document.documentElement.lang==="ar"'),"Arabic party scenario locale");
  const {runPartiesReportScenarios}=await import("./parties-ui-scenarios.mjs");
  result.partyReports=await runPartiesReportScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.partyReports.checkpoints);
  const {runExpenseOverviewScenarios}=await import("./expense-overview-ui-scenarios.mjs");
  result.expenseOverview=await runExpenseOverviewScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.expenseOverview.checkpoints);
  const {runInvoiceTotalsScenarios}=await import("./invoice-totals-ui-scenarios.mjs");
  result.invoiceTotals=await runInvoiceTotalsScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.invoiceTotals.checkpoints);
  const {runStockSettlementScenarios}=await import("./stock-settlement-ui-scenarios.mjs");
  result.stockSettlements=await runStockSettlementScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.stockSettlements.checkpoints);
  const {runWorkerCorrectionScenarios}=await import("./worker-correction-ui-scenarios.mjs");
  result.workerCorrections=await runWorkerCorrectionScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.workerCorrections.checkpoints);
  const {runEmployeeOpeningScenarios}=await import("./employee-opening-ui-scenarios.mjs");
  result.employeeOpenings=await runEmployeeOpeningScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.employeeOpenings.checkpoints);
  const {runExpenseTimeScenarios}=await import("./expense-time-ui-scenarios.mjs");
  result.expenseTimes=await runExpenseTimeScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.expenseTimes.checkpoints);
  const {runPayrollPaymentBalanceScenarios}=await import("./payroll-payment-balance-ui-scenarios.mjs");
  result.payrollPaymentBalances=await runPayrollPaymentBalanceScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.payrollPaymentBalances.checkpoints);
  const {runMovementStatementScenarios}=await import("./movement-statement-ui-scenarios.mjs");
  result.movementStatements=await runMovementStatementScenarios({cdp,origin:base,command,database,screenshot});
  result.checkpoints.push(...result.movementStatements.checkpoints);
  const remainderNote=await preparePerfumeNoteFixture({cdp,command,database,screenshot});
  result.remainderNoteForm={sourceId:remainderNote.id,layouts:remainderNote.layouts,savedFromActualTextarea:true,businessTermsUnchanged:true};
  result.documentNotes=await runDocumentNotesMatrix({cdp,command,database,screenshot,extras:[remainderNote]});
  result.checkpoints.push(...result.documentNotes.checkpoints);
  result.checkpoints.push("The actual remainder-sale textarea reloads its saved note, saves a changed multiline note through the native confirmation, and reopens it in invoice/print/Excel while cash, liquid quantities, allocations and saved costs remain fixed");
  assert.deepEqual(cdp.errors, []);
  const {runPartyOpeningNotesScenarios}=await import("./party-opening-notes-ui-scenarios.mjs");
  result.partyOpeningNotes=await runPartyOpeningNotesScenarios({cdp,command,database,screenshot});
  result.checkpoints.push(...result.partyOpeningNotes.checkpoints);
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
  await screenshot("perfume-opening-form-1024",1024);
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

async function preparePerfumeNoteFixture({cdp,command,database,screenshot}) {
  const evaluate=code=>cdp.evaluate(code),until=async(check,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error("Timed out waiting for "+label)};
  const data=await (await fetch("http://127.0.0.1:"+server.address().port+"/api/bootstrap")).json(),warehouse=data.warehouses.find(row=>row.isSalesDefault&&!row.isArchived);assert(warehouse);
  const accountId=await command({type:"payment-account.create",name:"حساب ملاحظة بيع المتبقي",openingBalance:0});
  const sourceId=await command({type:"product.create",name:"عطر ملاحظة بيع المتبقي",pieceCost:1000,piecePrice:1500,openingStock:1,openingWarehouseId:warehouse.id});
  const conversionId=await command({type:"perfume-split.post",sourceProductId:sourceId,warehouseId:warehouse.id,volumeMl:100,priceBasisMl:10,salePrice:200});
  const conversion=await database.collection("documents").findOne({id:conversionId}),initial="ملاحظة بيع المتبقي قبل التعديل";
  const id=await command({type:"perfume-remainder-sale.post",productId:conversion.decantProductId,lotId:conversion.perfumeLotId,warehouseId:warehouse.id,quantityMl:5,totalPrice:100,paymentMethod:accountId,cashAmount:100,note:initial});
  const source=await database.collection("documents").findOne({id}),lineProjection=document=>document.lines.map(line=>Object.fromEntries(["productId","quantity","quantityUnit","liquidQuantityMl","unitPrice","lineTotal","costAtSale","grossProfit","perfumeAllocations"].map(key=>[key,line[key]])));
  const business=async()=>{const product=await database.collection("products").findOne({id:conversion.decantProductId}),lot=product.perfumeLots.find(row=>row.id===conversion.perfumeLotId);return{cash:(await database.collection("paymentAccounts").findOne({id:accountId})).balance,stocks:product.stocks,lot:Object.fromEntries(["stocks","remainingQuantity","liquidUnitCost","landedUnitCost","settledAt","totalLandedCost","bookValue"].map(key=>[key,lot[key]]))}};
  const before=await business(),lines=lineProjection(source),note="ملاحظة بيع المتبقي المحفوظة <&>\nTexte français de la vente du reliquat.\nلا تتغير كمية السائل أو التكلفة أو النقد.";
  await evaluate('window.__smokeSetLocale("ar")');assert.equal(await evaluate('window.__smokeEditPerfumeNote('+JSON.stringify(id)+')'),true);
  await until(()=>evaluate('document.querySelector(".pm-editor-form textarea")?.value==='+JSON.stringify(initial)),"saved remainder note in actual textarea");
  await evaluate('(()=>{const e=document.querySelector(".pm-editor-form textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(note)+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  const layouts=await captureControlLayouts({cdp,screenshot,scope:".pm-editor-form label.pm-wide:has(textarea)",name:"notes-remainder-textarea-ar",widths:[1280,480]});
  await evaluate('(()=>{const b=document.querySelector(".pm-form-actions button.primary");if(!b||b.disabled)throw Error("Unavailable remainder save");b.click()})()');
  await until(()=>evaluate('Boolean(document.querySelector(".app-confirm-dialog"))'),"native remainder edit confirmation");
  await evaluate('document.querySelector(".app-confirm-actions button:first-child").click()');
  let saved;await until(async()=>{saved=await database.collection("documents").findOne({id});return saved?.note===note&&await evaluate("!window.__payrollBusy")},"typed remainder note committed");
  assert.deepEqual(await business(),before,"Remainder note edit preserves liquid lots and cash");assert.deepEqual(lineProjection(saved),lines,"Remainder note edit preserves allocations and saved cost/revenue");assert.equal(saved.total,source.total);
  return{id,label:"perfume-remainder",note,layouts};
}

async function runDocumentNotesMatrix({cdp,command,database,screenshot,extras=[]}) {
  const evaluate=code=>cdp.evaluate(code),checkpoints=[],cases=[],exports=[],layouts=[];
  const until=async(check,label)=>{const end=Date.now()+25000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error("Timed out waiting for "+label)};
  const click=selector=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled)throw Error("Unavailable note control");e.click()})()');
  const fill=(selector,value)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)throw Error("Missing note control");const p=e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
  const {displayDocumentNumber}=await import("../lib/document-sequences.ts");
  const today=new Date().toISOString().slice(0,10),bootstrap=await (await fetch("http://127.0.0.1:"+server.address().port+"/api/bootstrap")).json();
  const warehouse=bootstrap.warehouses.find(row=>row.isSalesDefault&&!row.isArchived);assert(warehouse);
  const accountId=await command({type:"payment-account.create",name:"حساب مصفوفة ملاحظات السندات",openingBalance:2000});
  const productId=await command({type:"product.create",name:"منتج مصفوفة الملاحظات",pieceCost:10,piecePrice:20,openingStock:20,openingWarehouseId:warehouse.id});
  const otherWarehouseId=await command({type:"warehouse.create",name:"مخزن مصفوفة الملاحظات"});
  const partyId=await command({type:"party.create",partyType:"customer",name:"عميل مصفوفة الملاحظات"});
  const employeeId=await command({type:"employee.create",name:"عامل مصفوفة الملاحظات",amount:0,startDate:today,intervalMonths:1,entitlement:"end"});
  const longNote="سند محفوظ: <&> نص عربي لا يترجم.\nTexte français conservé intégralement.\n"+("تفاصيل متعددة للملاحظة المحفوظة دون تغيير مالي. ".repeat(5)).trim();
  const add=async(id,label,note)=>{await database.collection("documents").updateOne({id},{$set:{note}});cases.push({id,label,note})};
  await add(await command({type:"purchase.post",warehouseId:warehouse.id,paymentMethod:accountId,lines:[{productId,quantity:10,unitPrice:10}]}),"purchase","شراء");
  await add(await command({type:"sale.post",warehouseId:warehouse.id,paymentMethod:accountId,lines:[{productId,quantity:2,piecePrice:20}]}),"sale",longNote);
  await add(await command({type:"expense.post",title:"مصروف له ملاحظة محفوظة",amount:5,occurredAt:today,paymentMethod:accountId}),"expense","ملاحظة المصروف <&>");
  await add(await command({type:"transfer.post",fromWarehouseId:warehouse.id,toWarehouseId:otherWarehouseId,lines:[{productId,quantity:1}]}),"stock-transfer","ملاحظة تحويل المخزون");
  await add(await command({type:"adjustment.post",warehouseId:warehouse.id,reason:"سبب جرد مستقل عن الملاحظة",lines:[{productId,actualQuantity:28}]}),"stock-adjustment",longNote);
  await add(await command({type:"party-opening.post",partyId,direction:"receivable",amount:11,note:"رصيد افتتاحي محفوظ"}),"party-opening","رصيد افتتاحي محفوظ");
  await add(await command({type:"party-cash.post",partyId,direction:"pay",amount:3,paymentMethod:accountId,note:"إرجاع مبلغ للعميل"}),"party-refund","إرجاع مبلغ للعميل");
  await add(await command({type:"employee-payment.post",employeeId,direction:"deposit",amount:4,paymentMethod:accountId,occurredAt:today,note:"ملاحظة حركة العامل"}),"worker-payment","ملاحظة حركة العامل");
  await add(await command({type:"account-transfer.post",fromAccountId:accountId,toAccountId:bootstrap.paymentAccounts.find(row=>row.isActive&&!row.isArchived).id,amount:6,note:"بيان تحويل الحسابات"}),"account-transfer","بيان تحويل الحسابات");
  await add(await command({type:"sale.post",warehouseId:warehouse.id,paymentMethod:accountId,lines:[{productId,quantity:1,piecePrice:20}]}),"empty-sale","");
  cases.push(...extras);
  await evaluate('window.__smokeSetView("records")');
  const snapshot=()=>Promise.all(["products","parties","employees","warehouses","documents","stockMovements","financialMovements","paymentAccounts","accountTransfers","auditEvents","commandReceipts"].map(name=>database.collection(name).find().sort({id:1,_id:1}).toArray()));
  const before=await snapshot();
  const texts=bytes=>{const data=Buffer.from(bytes),cells=[];let offset=0;while(offset+30<=data.length&&data.readUInt32LE(offset)===0x04034b50){const flags=data.readUInt16LE(offset+6),method=data.readUInt16LE(offset+8),size=data.readUInt32LE(offset+18),nameLength=data.readUInt16LE(offset+26),extraLength=data.readUInt16LE(offset+28),name=data.subarray(offset+30,offset+30+nameLength).toString("utf8"),start=offset+30+nameLength+extraLength;assert.equal(flags&8,0);assert(start+size<=data.length);assert([0,8].includes(method));if(/^xl\/worksheets\/.+\.xml$/.test(name)){const packed=data.subarray(start,start+size),xml=(method===8?inflateRawSync(packed):packed).toString("utf8");for(const match of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))cells.push(match[1].replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replaceAll("&amp;","&"))}offset=start+size}assert(cells.length);return cells};
  await evaluate('(()=>{window.__notesPreviousPrinting=window.alkarnaPrinting;window.__noteExports=[];window.__smokeNotesReadMode=true;window.alkarnaPrinting={getSettings:async()=>({deviceName:null,profile:"a4"}),saveExport:async request=>{window.__noteExports.push({name:request.suggestedName,bytes:Array.from(request.data)});return{ok:true}}}})()');
  try {
    for(const entry of cases){
      const document=await database.collection("documents").findOne({id:entry.id});assert(document);const reference=displayDocumentNumber(document);
      for(const locale of ["ar","fr"]){
        await evaluate('window.__smokeSetLocale('+JSON.stringify(locale)+')');await until(()=>evaluate('document.documentElement.lang==='+JSON.stringify(locale)),"note locale");
        await evaluate('window.__smokeSetView("records")');await until(()=>evaluate('Boolean(document.querySelector(".records-kind-filter"))'),"actual Records source list");
        const historyStart=cdp.network.length;
        await click(".records-filters .compact-date-range button:last-child");
        await fill(".records-kind-filter",document.kind);await fill('.records-filters input:not([type=date])',document.number);
        await until(()=>cdp.network.slice(historyStart).some(entry=>{if(typeof entry.url!=="string"||!entry.url.includes("/api/history?"))return false;const query=new URL(entry.url).searchParams;return entry.status===200&&query.get("kind")===document.kind&&query.get("q")===document.number}),"filtered source history response");
        await until(()=>evaluate('(()=>{const t=document.querySelector(".records-workspace .recent-table tbody");return t&&[...t.querySelectorAll("tr")].some(r=>r.children.length>=7&&r.children[2]?.textContent.trim()==='+JSON.stringify(reference)+')})()'),"persisted note source in Records");
        await evaluate('(()=>{const row=[...document.querySelectorAll(".records-workspace .recent-table tbody tr")].find(r=>r.children.length>=7&&r.children[2]?.textContent.trim()==='+JSON.stringify(reference)+');if(!row)throw Error("Missing note source");row.click()})()');
        await until(()=>evaluate('Boolean(document.querySelector(".official-document-layout"))'),"actual document notes preview");
        assert.equal(await evaluate('window.__openedPayrollDocument'),entry.id,"Records routes the selected source identity");
        const shown=await evaluate('({screen:[...document.querySelectorAll(".official-document-scroll .official-record-meta b")].map(e=>e.textContent.trim()),print:[...document.querySelectorAll(".document-print-portal .official-record-meta b")].map(e=>e.textContent.trim()),noteLabels:[...document.querySelectorAll(".official-document-scroll .official-record-meta small")].map(e=>e.textContent.trim())})');
        if(entry.note){assert.equal(shown.screen.filter(text=>text===entry.note).length,1,entry.label+" literal note appears once");assert.equal(shown.print.filter(text=>text===entry.note).length,1,entry.label+" print note appears once")}
        else assert.equal(shown.noteLabels.some(text=>["ملاحظة","Note"].includes(text)),false,"An empty note does not create an empty metadata row");
        if(["sale","stock-adjustment"].includes(entry.label)&&locale==="fr")layouts.push(...await captureControlLayouts({cdp,screenshot,scope:".official-document-layout",name:"notes-"+entry.label+"-"+locale,widths:[1280,480]}));
        if(entry.note.includes("\n")){const geometry=await evaluate('(()=>{const e=[...document.querySelectorAll(".official-document-scroll .official-record-meta b")].find(e=>e.textContent.trim()==='+JSON.stringify(entry.note)+');const r=e.getBoundingClientRect();return{width:e.clientWidth,scrollWidth:e.scrollWidth,whiteSpace:getComputedStyle(e).whiteSpace,left:r.left,right:r.right}})()');assert(geometry.scrollWidth<=geometry.width+1,"Long saved note wraps within metadata");assert(["pre-wrap","pre-line","break-spaces"].includes(geometry.whiteSpace))}
        if(entry.label==="sale"&&locale==="ar")await screenshot("notes-sale-ar-1280",1280);
        const count=await evaluate("window.__noteExports.length");await click(".official-document-toolbar button.soft");await until(()=>evaluate('Boolean(document.querySelector(".output-choice-dialog"))'),"notes output choice");await click(".output-choice-grid button:last-child");await until(()=>evaluate("window.__noteExports.length>"+count),"actual note Excel bytes");
        const workbook=await evaluate("window.__noteExports.at(-1)"),values=texts(workbook.bytes);if(entry.note)assert.equal(values.filter(text=>text===entry.note).length,1,"Actual Excel contains the literal note exactly once");
        exports.push({kind:entry.label,locale,bytes:workbook.bytes.length,note:entry.note,sourceId:entry.id});
        await click(".official-document-toolbar button.back");await until(()=>evaluate('!document.querySelector(".official-document-layout")'),"closed notes source");
      }
    }
    assert.deepEqual(await snapshot(),before,"Source notes, amounts, stock, cash, parties, costs, audit and receipts stay unchanged during preview/print/Excel reads");
    checkpoints.push("Persisted notes across invoices, expenses, stock movements, opening balances, refunds and worker/account cash sources reopen through actual Records and appear once in native preview, print and actual Excel in Arabic and French");
    checkpoints.push("Literal translation-key and long multiline notes remain untranslated, empty notes omit their row, strict AR/FR layouts pass and every source/financial/stock snapshot remains unchanged on read");
    return{checkpoints,cases:cases.map(({id,label,note})=>({id,kind:label,note})),exports,layouts,sourceSnapshotsUnchanged:true};
  } finally {await evaluate('(()=>{window.alkarnaPrinting=window.__notesPreviousPrinting;delete window.__notesPreviousPrinting;delete window.__noteExports;delete window.__smokeNotesReadMode})()')}
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
