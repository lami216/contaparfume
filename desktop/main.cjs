/* eslint-disable @typescript-eslint/no-require-imports */
const {app,BrowserWindow,Menu,shell,dialog,session}=require('electron');
const PRODUCT_NAME='الكرنه';
app.setName(PRODUCT_NAME);
const {spawn}=require('node:child_process');const {join}=require('node:path');const {mkdirSync,createWriteStream}=require('node:fs');const {writeFile}=require('node:fs/promises');const crypto=require('node:crypto');const net=require('node:net');const {createCloseFlow}=require('./close-flow.cjs');
let window,server,quitting=false,ready=false,logStream,logPath,closeFlow,serverUrl;const desktopToken=crypto.randomBytes(32).toString('base64url');
const lock=app.requestSingleInstanceLock();if(!lock)app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus()}});
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))});s.on('error',reject)});
const stamp=message=>{logStream?.write(`[${new Date().toISOString()}] ${message}\n`)};
const stopServer=()=>new Promise(resolve=>{if(!server||server.exitCode!==null)return resolve();const timer=setTimeout(()=>{server?.kill('SIGKILL');resolve()},5000);server.once('exit',()=>{clearTimeout(timer);resolve()});server.kill()});
async function failStartup(){ready=false;stamp(`health timeout; log=${logPath}`);await stopServer();logStream?.end();dialog.showErrorBox(PRODUCT_NAME,`تعذر تشغيل الكرنه.\nراجع سجل التشغيل:\n${logPath}`);app.quit()}
async function start(){
 const port=await freePort(),userData=app.getPath('userData'),root=app.isPackaged?join(process.resourcesPath,'alkarna-runtime'):process.cwd(),entry=app.isPackaged?join(root,'server.js'):join(root,'node_modules','next','dist','bin','next'),args=app.isPackaged?[entry]:[entry,'dev','-H','127.0.0.1','-p',String(port)];
 const logs=join(userData,'logs');mkdirSync(logs,{recursive:true});logPath=join(logs,'desktop-server.log');logStream=createWriteStream(logPath,{flags:'a'});stamp(`spawn port=${port} executable=${process.execPath} cwd=${root} entry=${entry}`);
 server=spawn(process.execPath,args,{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_ENV:app.isPackaged?'production':'development',ALKARNA_DESKTOP:'1',ALKARNA_DESKTOP_TOKEN:desktopToken,HOSTNAME:'127.0.0.1',PORT:String(port),ALKARNA_USER_DATA:userData,ALKARNA_DATABASE_PATH:join(userData,'data','alkarna.sqlite')},stdio:['ignore','pipe','pipe'],windowsHide:true});
 server.stdout.on('data',chunk=>logStream.write(chunk));server.stderr.on('data',chunk=>logStream.write(chunk));server.on('error',error=>stamp(`child error: ${error.stack||error}`));server.on('exit',(code,signal)=>{stamp(`child exit code=${code} signal=${signal}`);if(ready&&!quitting){dialog.showErrorBox(PRODUCT_NAME,`توقف خادم الكرنه بشكل غير متوقع.\nراجع سجل التشغيل:\n${logPath}`);window?.destroy();app.quit()}});
 const url=`http://127.0.0.1:${port}`;serverUrl=url;for(let i=0;i<120;i++){if(server.exitCode!==null)break;try{const response=await fetch(`${url}/api/health`);if(response.status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!ready)return failStartup();stamp('health ready');
 window=new BrowserWindow({title:PRODUCT_NAME,width:1500,height:900,minWidth:1100,minHeight:700,icon:join(root,'public','alkarna-logo.png'),webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});const expectedOrigin=new URL(url).origin,isLocal=target=>{try{return new URL(target).origin===expectedOrigin}catch{return false}};
 Menu.setApplicationMenu(null);window.webContents.setWindowOpenHandler(({url:target})=>{if(isLocal(target))return{action:'allow'};shell.openExternal(target);return{action:'deny'}});window.webContents.on('will-navigate',(event,target)=>{if(!isLocal(target))event.preventDefault()});
 closeFlow=createCloseFlow({dialog,window:()=>window,fetchBackup:async()=>{const response=await fetch(`${serverUrl}/api/desktop/backup`,{headers:{'x-alkarna-desktop-token':desktopToken}});if(!response.ok)throw Error(`backup HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer())},writeBackup:writeFile,onFailure:async error=>{stamp(`backup failed: ${error.stack||error}`);await dialog.showMessageBox(window,{type:'error',title:PRODUCT_NAME,message:'تعذر إنشاء النسخة الاحتياطية. لم يتم إغلاق البرنامج.',buttons:['حسنًا']})},approveQuit:async()=>{quitting=true;await stopServer();logStream?.end();app.quit()}});
 window.on('close',event=>{if(quitting||closeFlow.isApproved())return;event.preventDefault();void closeFlow.requestClose().then(closed=>{if(!closed&&window&&!window.isDestroyed()){window.focus();window.webContents.focus()}})});
 await session.defaultSession.cookies.remove(url,'conta_session');
 await window.loadURL(url);window.maximize();
}
app.whenReady().then(start).catch(async error=>{stamp(`startup error: ${error.stack||error}`);await failStartup()});
app.on('before-quit',event=>{if(quitting)return;if(!ready||!closeFlow){quitting=true;return}event.preventDefault();void closeFlow.requestClose().then(closed=>{if(!closed&&window&&!window.isDestroyed()){window.focus();window.webContents.focus()}})});app.on('window-all-closed',()=>{if(quitting)app.quit()});
