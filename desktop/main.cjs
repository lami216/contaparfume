/* eslint-disable @typescript-eslint/no-require-imports */
const {app,BrowserWindow,Menu,shell,dialog,session,ipcMain}=require('electron');
const PRODUCT_NAME='الكرنة للعطور';
const APP_ID='mr.alkarna.perfume.desktop';
const USER_DATA_DIR='AlKarna-Perfume';
app.setName(PRODUCT_NAME);
const {spawn}=require('node:child_process');const {join}=require('node:path');const {mkdirSync,createWriteStream}=require('node:fs');const {writeFile,readFile}=require('node:fs/promises');const crypto=require('node:crypto');const net=require('node:net');const {createCloseFlow}=require('./close-flow.cjs');
const isolatedUserData=join(app.getPath('appData'),USER_DATA_DIR);
mkdirSync(isolatedUserData,{recursive:true});
app.setPath('userData',isolatedUserData);
let window,server,quitting=false,ready=false,logStream,logPath,closeFlow,serverUrl;const desktopToken=crypto.randomBytes(32).toString('base64url');
const PRINT_PROFILES=new Set(['a4','thermal80','thermal58']);
const DEFAULT_PRINT_SETTINGS={deviceName:null,profile:'a4'};
const THERMAL_PAPER_WIDTH_MICRONS={thermal80:80000,thermal58:58000};
const lock=app.requestSingleInstanceLock();if(!lock)app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus()}});
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))});s.on('error',reject)});
const stamp=message=>{logStream?.write(`[${new Date().toISOString()}] ${message}\n`)};
const normalizePrintSettings=value=>{const source=value&&typeof value==='object'?value:{},profile=PRINT_PROFILES.has(source.profile)?source.profile:'a4',deviceName=typeof source.deviceName==='string'&&source.deviceName.trim()?source.deviceName.trim():null;return{deviceName,profile}};
const printingSettingsPath=()=>join(app.getPath('userData'),'printing-settings.json');
async function getPrintingSettings(){try{return normalizePrintSettings(JSON.parse(await readFile(printingSettingsPath(),'utf8')))}catch{return{...DEFAULT_PRINT_SETTINGS}}}
async function savePrintingSettings(value){const settings=normalizePrintSettings(value),path=printingSettingsPath();mkdirSync(app.getPath('userData'),{recursive:true});await writeFile(path,JSON.stringify(settings,null,2),'utf8');return settings}
let printingHandlersRegistered=false;
function registerPrintingHandlers(){if(printingHandlersRegistered)return;printingHandlersRegistered=true;
 ipcMain.handle('alkarna:printing:list',async event=>(await event.sender.getPrintersAsync()).map(printer=>({name:printer.name,displayName:printer.displayName||printer.name,description:printer.description||'',status:printer.status,isDefault:Boolean(printer.isDefault)})));
 ipcMain.handle('alkarna:printing:get-settings',()=>getPrintingSettings());
 ipcMain.handle('alkarna:printing:set-settings',(_event,value)=>savePrintingSettings(value));
 ipcMain.handle('alkarna:printing:print',async(event,value)=>{
  const settings=normalizePrintSettings(value),silent=Boolean(value?.silent),printers=await event.sender.getPrintersAsync();
  if(settings.deviceName&&!printers.some(printer=>printer.name===settings.deviceName))return{ok:false,error:'printer-not-found'};
  const thermalWidth=THERMAL_PAPER_WIDTH_MICRONS[settings.profile],rawHeight=Number(value?.paperHeightMicrons),thermalHeight=Number.isFinite(rawHeight)?Math.max(50000,Math.min(1000000,Math.round(rawHeight))):null;
  const baseOptions={silent,printBackground:true,deviceName:settings.deviceName||undefined};
  const options=settings.profile==='a4'?{...baseOptions,pageSize:'A4'}:thermalWidth&&thermalHeight?{...baseOptions,pageSize:{width:thermalWidth,height:thermalHeight},margins:{marginType:'none'},landscape:false}:{...baseOptions,usePrinterDefaultPageSize:true};
  const runPrint=printOptions=>new Promise(resolve=>event.sender.print(printOptions,(success,failureReason)=>{stamp(`print profile=${settings.profile} printer=${settings.deviceName||'windows-default'} silent=${silent} success=${success}${failureReason?` reason=${failureReason}`:''}`);resolve(success?{ok:true}:{ok:false,error:failureReason||'print-failed'})}));
  const result=await runPrint(options);
  if(result.ok||!thermalWidth||!thermalHeight||!/invalid printer settings/i.test(result.error))return result;
  stamp(`retry print profile=${settings.profile} with printer default page size`);
  return runPrint({...baseOptions,usePrinterDefaultPageSize:true});
 });
}
const stopServer=()=>new Promise(resolve=>{if(!server||server.exitCode!==null)return resolve();const timer=setTimeout(()=>{server?.kill('SIGKILL');resolve()},5000);server.once('exit',()=>{clearTimeout(timer);resolve()});server.kill()});
async function failStartup(){ready=false;stamp(`health timeout; log=${logPath}`);await stopServer();logStream?.end();dialog.showErrorBox(PRODUCT_NAME,`تعذر تشغيل الكرنة للعطور.\nراجع سجل التشغيل:\n${logPath}`);app.quit()}
async function start(){
 registerPrintingHandlers();
 const port=await freePort(),userData=app.getPath('userData'),root=app.isPackaged?join(process.resourcesPath,'alkarna-runtime'):process.cwd(),entry=app.isPackaged?join(root,'server.js'):join(root,'node_modules','next','dist','bin','next'),args=app.isPackaged?[entry]:[entry,'dev','-H','127.0.0.1','-p',String(port)];
 const logs=join(userData,'logs');mkdirSync(logs,{recursive:true});logPath=join(logs,'desktop-server.log');logStream=createWriteStream(logPath,{flags:'a'});stamp(`spawn port=${port} executable=${process.execPath} cwd=${root} entry=${entry}`);
 server=spawn(process.execPath,args,{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_ENV:app.isPackaged?'production':'development',ALKARNA_DESKTOP:'1',ALKARNA_DESKTOP_TOKEN:desktopToken,HOSTNAME:'127.0.0.1',PORT:String(port),ALKARNA_USER_DATA:userData,ALKARNA_DATABASE_PATH:join(userData,'data','alkarna-perfume.sqlite'),ALKARNA_LICENSE_STATE_PATH:join(process.env.LOCALAPPDATA||userData,'PayZone','AlKarna-Perfume-Licensing','state-v2.json'),ALKARNA_LICENSE_DISABLE_REGISTRY:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 server.stdout.on('data',chunk=>logStream.write(chunk));server.stderr.on('data',chunk=>logStream.write(chunk));server.on('error',error=>stamp(`child error: ${error.stack||error}`));server.on('exit',(code,signal)=>{stamp(`child exit code=${code} signal=${signal}`);if(ready&&!quitting){dialog.showErrorBox(PRODUCT_NAME,`توقف خادم الكرنة للعطور بشكل غير متوقع.\nراجع سجل التشغيل:\n${logPath}`);window?.destroy();app.quit()}});
 const url=`http://127.0.0.1:${port}`;serverUrl=url;for(let i=0;i<120;i++){if(server.exitCode!==null)break;try{const response=await fetch(`${url}/api/health`);if(response.status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!ready)return failStartup();stamp('health ready');
 window=new BrowserWindow({title:PRODUCT_NAME,width:1500,height:900,minWidth:1100,minHeight:700,icon:join(root,'public','alkarna-logo.png'),webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});const expectedOrigin=new URL(url).origin,isLocal=target=>{try{return new URL(target).origin===expectedOrigin}catch{return false}};
 Menu.setApplicationMenu(null);window.webContents.setWindowOpenHandler(({url:target})=>{if(isLocal(target))return{action:'allow'};shell.openExternal(target);return{action:'deny'}});window.webContents.on('will-navigate',(event,target)=>{if(!isLocal(target))event.preventDefault()});
 closeFlow=createCloseFlow({dialog,window:()=>window,fetchBackup:async()=>{const response=await fetch(`${serverUrl}/api/desktop/backup`,{headers:{'x-alkarna-desktop-token':desktopToken}});if(!response.ok)throw Error(`backup HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer())},writeBackup:writeFile,onFailure:async error=>{stamp(`backup failed: ${error.stack||error}`);await dialog.showMessageBox(window,{type:'error',title:PRODUCT_NAME,message:'تعذر إنشاء النسخة الاحتياطية. لم يتم إغلاق البرنامج.',buttons:['حسنًا']})},approveQuit:async()=>{quitting=true;await stopServer();logStream?.end();app.quit()}});
 window.on('close',event=>{if(quitting||closeFlow.isApproved())return;event.preventDefault();void closeFlow.requestClose().then(closed=>{if(!closed&&window&&!window.isDestroyed()){window.focus();window.webContents.focus()}})});
 await session.defaultSession.cookies.remove(url,'conta_session');
 await window.loadURL(url);
 window.webContents.on('did-fail-load',(_event,errorCode,errorDescription,validatedURL,isMainFrame)=>{
  if(!isMainFrame||quitting||!isLocal(validatedURL))return;
  stamp(`main-frame load failed code=${errorCode} description=${errorDescription} url=${validatedURL}`);
  const recovery=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${PRODUCT_NAME}</title><style>body{font-family:Tahoma,Arial,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f8fa;color:#1f2937}.card{width:min(520px,88vw);background:white;border:1px solid #ddd;border-radius:14px;padding:28px;text-align:center;box-shadow:0 12px 36px #0002}button{border:0;border-radius:9px;padding:10px 18px;background:#1967d2;color:white;font-weight:700;cursor:pointer}</style><body><div class="card"><h2>تعذر تحميل الصفحة داخل الكرنه</h2><p>لم يتم إغلاق البرنامج أو تغيير البيانات. اضغط إعادة المحاولة للرجوع إلى النظام.</p><button onclick="location.replace('${url}')">إعادة المحاولة</button></div></body></html>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recovery)}`).catch(error=>stamp(`recovery page failed: ${error.stack||error}`));
 });
 window.maximize();
}
app.whenReady().then(start).catch(async error=>{stamp(`startup error: ${error.stack||error}`);await failStartup()});
app.on('before-quit',event=>{if(quitting)return;if(!ready||!closeFlow){quitting=true;return}event.preventDefault();void closeFlow.requestClose().then(closed=>{if(!closed&&window&&!window.isDestroyed()){window.focus();window.webContents.focus()}})});app.on('window-all-closed',()=>{if(quitting)app.quit()});
