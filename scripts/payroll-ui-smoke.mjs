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
  status: "running", mode: "Actual React employee component and real command/bootstrap routes in an isolated CI profile",
  ciOnly: true, licenseBypass: "test-only CI", screenshots: [], checkpoints: [],
};
let database, closeDatabase, server, chrome, cdp;

async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(), errors = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
    call, errors, close: () => socket.close(),
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
  const bootstrapCheck = await GET(new Request("http://127.0.0.1:3219/api/bootstrap"));
  assert.equal(bootstrapCheck.status, 200, await bootstrapCheck.text());
  const date = new Date().toISOString().slice(0, 10);
  const employeeId = await database.transaction(session => execute(database, session, {
    type: "employee.create", name: "عامل فحص الواجهة", phone: "00000000", amount: 100,
    startDate: date, intervalMonths: 12, entitlement: "beginning",
  }));

  const entry = `
    import React,{useCallback,useEffect,useState} from "react";
    import{createRoot}from"react-dom/client";
    import EmployeesPage from "./app/employees-page";
    import{LocaleProvider}from"./app/i18n/provider";
    import{ConfirmationProvider}from"./app/app-confirm";
    function Shell(){
      const[data,setData]=useState(null),[sourceId,setSourceId]=useState(${JSON.stringify(employeeId)});
      const register=useCallback(()=>{},[]);
      useEffect(()=>{fetch("/api/bootstrap").then(r=>r.json()).then(setData)},[]);
      const run=async body=>{
        window.__payrollBusy=true;
        try{
          const response=await fetch("/api/command",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(body)});
          const value=await response.json();if(!response.ok)throw new Error(value.error);
          const fresh=await fetch("/api/bootstrap");setData(await fresh.json());
          window.__lastPayrollResult=value;return value.id;
        }finally{window.__payrollBusy=false}
      };
      return data?<EmployeesPage data={data} run={run} openDoc={id=>{window.__openedPayrollDocument=id}} sourceId={sourceId} clearSource={()=>setSourceId(null)} registerEditorGuard={register}/>:<p>Loading</p>;
    }
    createRoot(document.getElementById("root")).render(<LocaleProvider initialLocale="ar"><ConfirmationProvider><Shell/></ConfirmationProvider></LocaleProvider>);
  `;
  const bundled = await build({
    absWorkingDir: source, stdin: { contents: entry, resolveDir: source, loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  const script = bundled.outputFiles[0].contents;
  const css = fs.readFileSync(path.join(source, "app", "globals.css"), "utf8").replace(/^[ \t]*@import[^\r\n]*;[ \t]*(?:\r?\n|$)/gm, "");
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
    const layout = await cdp.evaluate(`(()=>{
      const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,right:r.right,y:r.y,bottom:r.bottom}};
      return{list:box(".employees-list"),history:box(".employees-history"),account:box(".employees-account"),overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.equal(layout.overflow, false);
    if (width === 1280) {
      assert(layout.history.y >= layout.list.bottom - 1);
      assert(layout.history.right <= layout.account.x + 1 || layout.account.right <= layout.history.x + 1);
    }
    const capture = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(capture.data, "base64"));
    result.screenshots.push(name + ".png");
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
  await screenshot("withdrawal-1280", 1280);
  result.checkpoints.push("Actual UI withdrawal150 exceeds accrued100, cash850 and signed worker balance-50");
  await fill("نوع الحركة", "deposit");
  await fill("المبلغ", 30);
  await fill("وسيلة الدفع", account.id);
  await cdp.evaluate("window.__payrollUi.submit()");
  await expectState(-20, 880);
  const deposit = (await state()).documents.find(document => document.employeePaymentDirection === "deposit");
  assert(deposit);
  await screenshot("deposit-760", 760);
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
  await screenshot("after-voids-1280", 1280);
  result.checkpoints.push("Both void actions restore their original effects once, leaving accrual100 and cash1000");
  const final = await state();
  assert.equal(final.documents.filter(document => document.kind === "employee-accrual" && document.status === "posted").length, 1);
  assert.equal(final.documents.filter(document => document.kind === "employee-payment" && document.status === "posted").length, 0);
  assert.deepEqual(cdp.errors, []);
  result.status = "passed";
}

try {
  await main();
} catch (error) {
  result.status = "failed";
  result.error = error.stack;
  result.browserErrors = cdp?.errors ?? [];
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
