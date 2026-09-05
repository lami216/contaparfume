from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


app = Path("app/conta-app.tsx")
text = app.read_text(encoding="utf-8")
old = '<strong>{data.principal.name}</strong>'
new = '<strong>{data.principal.principalType==="local"?tr("دخول مباشر"):data.principal.name}</strong>'
if old not in text:
    raise SystemExit("principal display anchor not found")
app.write_text(text.replace(old, new, 1), encoding="utf-8")


divisions = Path("app/perfume-divisions.tsx")
text = divisions.read_text(encoding="utf-8")
card = '<section className="perfume-divisions-card">'
if text.count(card) < 2:
    raise SystemExit("expected two perfume division cards")
text = text.replace(card, '<section className="perfume-divisions-card perfume-split-card">', 1)
text = text.replace(card, '<section className="perfume-divisions-card perfume-batches-card">', 1)
divisions.write_text(text, encoding="utf-8")


css = Path("app/globals.css")
css_text = css.read_text(encoding="utf-8")
marker = "/* perfume-divisions-v1 */"
if marker not in css_text:
    raise SystemExit("perfume CSS marker not found")
css_text = css_text.split(marker, 1)[0].rstrip() + r'''

/* perfume-divisions-v2: compact, fixed desktop frame; only the growing batch list scrolls. */
.section-perfumeDivisions { --section-color: var(--color-products); --section-soft: #fff0e4; }
.perfume-divisions-page { display:grid; grid-template-rows:auto minmax(0,1fr); gap:8px; width:100%; height:100%; min-height:0; overflow:hidden; }
.perfume-divisions-card { min-width:0; min-height:0; padding:9px 11px; border:1px solid var(--border,#dfe3e8); border-radius:10px; background:var(--panel,#fff); box-shadow:0 4px 14px rgba(15,23,42,.045); overflow:hidden; }
.perfume-divisions-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:34px; }
.perfume-divisions-heading > div { min-width:0; }
.perfume-divisions-heading h2 { margin:0 0 2px; font-size:14px; line-height:1.25; }
.perfume-divisions-heading p { margin:0; color:var(--muted,#667085); font-size:10px; line-height:1.35; }
.perfume-split-action { flex:0 0 auto; min-width:185px; min-height:34px; height:34px; padding:4px 10px; border-radius:6px; font-size:10px; white-space:nowrap; }
.perfume-divisions-form { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:6px; margin-top:7px; }
.perfume-divisions-form label { display:grid; gap:2px; min-width:0; font-size:10px; font-weight:800; line-height:1.2; }
.perfume-divisions-form input,.perfume-divisions-form select,.perfume-recombine-control input { width:100%; height:32px; min-height:32px; padding:3px 7px; border:1px solid var(--border,#d0d5dd); border-radius:5px; background:var(--panel,#fff); color:inherit; font-size:11px; }
.perfume-cost-preview { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:4px; margin:7px 0 0; }
.perfume-cost-preview > div { display:grid; align-content:center; gap:1px; min-height:50px; padding:5px 7px; border:1px solid var(--border,#e4e7ec); border-radius:5px; overflow:hidden; }
.perfume-cost-preview span,.perfume-cost-preview small { color:var(--muted,#667085); font-size:9px; line-height:1.2; }
.perfume-cost-preview strong { font-size:13px; line-height:1.15; }
.perfume-batches-card { display:grid; grid-template-rows:auto minmax(0,1fr); gap:6px; overflow:hidden; }
.perfume-batches-table-wrap { min-width:0; min-height:0; height:100%; margin-top:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; border:1px solid var(--border,#d0d5dd); border-radius:5px; background:#fff; contain:paint; }
.perfume-batches-table { width:100%; min-width:980px; table-layout:fixed; }
.perfume-batches-table th,.perfume-batches-table td { height:30px; padding:3px 5px; font-size:9px; line-height:1.25; }
.perfume-batches-table th:last-child,.perfume-batches-table td:last-child { width:250px; }
.perfume-recombine-control { display:grid; gap:3px; min-width:210px; }
.perfume-recombine-control small { color:var(--muted,#667085); font-size:8.5px; line-height:1.2; }
.perfume-recombine-control input,.perfume-recombine-control button { height:27px; min-height:27px; padding:2px 6px; border-radius:4px; font-size:9px; }
.muted { color:var(--muted,#667085); }

/* The POS keeps its physical three-column arrangement, but text follows the active language. */
[dir="rtl"] .transaction-workspace > * { direction:rtl; }
[dir="ltr"] .transaction-workspace > * { direction:ltr; }
.app-shell[dir="rtl"] :is(input:not([type="number"]),textarea,select,.combobox-trigger) { direction:rtl; text-align:start; }
.app-shell[dir="ltr"] :is(input:not([type="number"]),textarea,select,.combobox-trigger) { direction:ltr; text-align:start; }

@media (max-width:1050px) {
  .perfume-divisions-page { height:auto; min-height:100%; overflow:visible; }
  .perfume-divisions-card { overflow:visible; }
  .perfume-divisions-form,.perfume-cost-preview { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .perfume-batches-card { min-height:360px; overflow:hidden; }
}
@media (max-width:620px) {
  .perfume-divisions-heading { align-items:stretch; flex-direction:column; }
  .perfume-split-action { width:100%; min-width:0; }
  .perfume-divisions-form,.perfume-cost-preview { grid-template-columns:1fr; }
}
'''
css.write_text(css_text + "\n", encoding="utf-8")


Path("desktop/close-flow.cjs").write_text(r'''const CLOSE_COPY={
 ar:{title:'الكرنه للعطور',message:'هل تريد حفظ نسخة احتياطية قبل إغلاق البرنامج؟',buttons:['نعم، حفظ نسخة','لا، خروج','إلغاء'],saveTitle:'حفظ النسخة الاحتياطية',filterName:'نسخة الكرنه للعطور',failure:'تعذر إنشاء النسخة الاحتياطية. لن يتم إغلاق البرنامج.',ok:'حسنًا'},
 fr:{title:'Al Karna — Parfums',message:'Voulez-vous enregistrer une sauvegarde avant de quitter ?',buttons:['Oui, sauvegarder','Non, quitter','Annuler'],saveTitle:'Enregistrer la sauvegarde',filterName:'Sauvegarde Al Karna Parfums',failure:"Impossible de créer la sauvegarde. L’application reste ouverte.",ok:'OK'}
};
function normalizeLocale(value){return value==='fr'?'fr':'ar'}
function closeCopy(locale){return CLOSE_COPY[normalizeLocale(locale)]}
function backupFilename(now=new Date()){const p=n=>String(n).padStart(2,'0');return `AlKarna-Perfume-backup-${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.conta.json`}
function createCloseFlow({dialog,window:windowValue,fetchBackup,writeBackup,approveQuit,onFailure,getLocale=async()=> 'ar'}){
 let active=false,approved=false;
 async function requestClose(){
  if(approved||active)return approved;active=true;
  try{const locale=normalizeLocale(await getLocale()),copy=closeCopy(locale);const {response}=await dialog.showMessageBox(windowValue(),{type:'question',title:copy.title,message:copy.message,buttons:copy.buttons,defaultId:0,cancelId:2,noLink:true});
   if(response===2)return false;
   if(response===1){approved=true;await approveQuit();return true}
   const saved=await dialog.showSaveDialog(windowValue(),{title:copy.saveTitle,defaultPath:backupFilename(),filters:[{name:copy.filterName,extensions:['conta.json','json']}]});
   if(saved.canceled||!saved.filePath)return false;
   try{const bytes=await fetchBackup();await writeBackup(saved.filePath,bytes)}catch(error){await onFailure(error);await dialog.showMessageBox(windowValue(),{type:'error',title:copy.title,message:copy.failure,buttons:[copy.ok],defaultId:0,cancelId:0,noLink:true});return false}
   approved=true;await approveQuit();return true;
  }finally{active=false}
 }
 return{requestClose,isApproved:()=>approved,isActive:()=>active};
}
module.exports={backupFilename,closeCopy,createCloseFlow};
''', encoding="utf-8")


main = Path("desktop/main.cjs")
text = main.read_text(encoding="utf-8")
old = "const USER_DATA_DIR='AlKarna-Perfume';"
new = "const USER_DATA_DIR='AlKarna-Perfume';\nconst LOCALE_COOKIE='alkarna_locale';"
if old not in text:
    raise SystemExit("desktop locale constant anchor not found")
text = text.replace(old, new, 1)
old = "const stamp=message=>{logStream?.write(`[${new Date().toISOString()}] ${message}\\n`)};"
new = old + "\nasync function currentLocale(){if(!serverUrl)return 'ar';try{const values=await session.defaultSession.cookies.get({url:serverUrl,name:LOCALE_COOKIE});return values[0]?.value==='fr'?'fr':'ar'}catch{return 'ar'}}"
if old not in text:
    raise SystemExit("desktop currentLocale anchor not found")
text = text.replace(old, new, 1)
old = "onFailure:async error=>{stamp(`backup failed: ${error.stack||error}`);await dialog.showMessageBox(window,{type:'error',title:PRODUCT_NAME,message:'تعذر إنشاء النسخة الاحتياطية. لم يتم إغلاق البرنامج.',buttons:['حسنًا']})}"
new = "getLocale:currentLocale,onFailure:async error=>{stamp(`backup failed: ${error.stack||error}`)}"
if old not in text:
    raise SystemExit("desktop close flow anchor not found")
text = text.replace(old, new, 1)
main.write_text(text, encoding="utf-8")


Path("tests/desktop-close-backup.test.mjs").write_text(r'''import test from "node:test";import assert from "node:assert/strict";import {createRequire} from "node:module";import {readFile} from "node:fs/promises";const require=createRequire(import.meta.url),{createCloseFlow,backupFilename}=require("../desktop/close-flow.cjs");
function harness(response,save={canceled:false,filePath:"/tmp/a.conta.json"},fail=false,locale="ar"){const calls=[],messageBoxes=[],saveDialogs=[];const flow=createCloseFlow({dialog:{showMessageBox:async(_window,options)=>{messageBoxes.push(options);return{response}},showSaveDialog:async(_window,options)=>{saveDialogs.push(options);return save}},window:()=>null,getLocale:async()=>locale,fetchBackup:async()=>{calls.push("backup");if(fail)throw Error("fail");return Buffer.from("data")},writeBackup:async()=>calls.push("write"),approveQuit:async()=>calls.push("quit"),onFailure:async()=>calls.push("failure")});return{flow,calls,messageBoxes,saveDialogs}}
test("YES saves before quit and cannot prompt twice",async()=>{const h=harness(0);assert.equal(await h.flow.requestClose(),true);assert.deepEqual(h.calls,["backup","write","quit"]);assert.equal(await h.flow.requestClose(),true);assert.deepEqual(h.calls,["backup","write","quit"])});
test("NO quits without backup",async()=>{const h=harness(1);assert.equal(await h.flow.requestClose(),true);assert.deepEqual(h.calls,["quit"])});
test("CANCEL and save cancellation keep app open",async()=>{let h=harness(2);assert.equal(await h.flow.requestClose(),false);assert.deepEqual(h.calls,[]);h=harness(0,{canceled:true});assert.equal(await h.flow.requestClose(),false);assert.deepEqual(h.calls,[])});
test("backup failure reports and does not quit",async()=>{const h=harness(0,undefined,true);assert.equal(await h.flow.requestClose(),false);assert.deepEqual(h.calls,["backup","failure"]);assert.equal(h.messageBoxes.length,2)});
test("French close and save dialogs follow the selected UI language",async()=>{let h=harness(2,undefined,false,"fr");assert.equal(await h.flow.requestClose(),false);assert.equal(h.messageBoxes[0].message,"Voulez-vous enregistrer une sauvegarde avant de quitter ?");assert.deepEqual(h.messageBoxes[0].buttons,["Oui, sauvegarder","Non, quitter","Annuler"]);h=harness(0,{canceled:true},false,"fr");await h.flow.requestClose();assert.equal(h.saveDialogs[0].title,"Enregistrer la sauvegarde");assert.equal(h.saveDialogs[0].filters[0].name,"Sauvegarde Al Karna Parfums")});
test("French backup failure stays localized",async()=>{const h=harness(0,undefined,true,"fr");assert.equal(await h.flow.requestClose(),false);assert.equal(h.messageBoxes[1].message,"Impossible de créer la sauvegarde. L’application reste ouverte.");assert.deepEqual(h.messageBoxes[1].buttons,["OK"])});
test("filename and desktop route security/source use native backup",async()=>{assert.match(backupFilename(new Date(2026,8,1,14,5)),/^AlKarna-Perfume-backup-2026-09-01-1405\.conta\.json$/);const route=await readFile(new URL("../app/api/desktop/backup/route.ts",import.meta.url),"utf8"),main=await readFile(new URL("../desktop/main.cjs",import.meta.url),"utf8");assert.match(route,/createNativeBackup\(await getDatabase\(\)\)/);assert.match(route,/timingSafeEqual/);assert.match(route,/ALKARNA_DESKTOP/);assert.match(main,/randomBytes\(32\)/);assert.match(main,/cookies\.get\(\{url:serverUrl,name:LOCALE_COOKIE\}\)/);assert.ok(main.indexOf('fetchBackup')<main.indexOf('approveQuit'))});
''', encoding="utf-8")


Path("tests/perfume-ui-i18n.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("perfume divisions fit the desktop frame and only the batch list scrolls", async () => {
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  const page=css.match(/\.perfume-divisions-page\s*\{([^}]*)\}/)?.[1]??"";
  const batches=css.match(/\.perfume-batches-card\s*\{([^}]*)\}/)?.[1]??"";
  const table=css.match(/\.perfume-batches-table-wrap\s*\{([^}]*)\}/)?.[1]??"";
  assert.match(page,/grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(page,/height:100%/);
  assert.match(page,/overflow:hidden/);
  assert.doesNotMatch(page,/overflow-y:auto/);
  assert.match(batches,/grid-template-rows:auto minmax\(0,1fr\)/);
  assert.match(batches,/overflow:hidden/);
  assert.match(table,/height:100%/);
  assert.match(table,/overflow:auto/);
});

test("Arabic and French controls follow locale direction and local access label is translated", async () => {
  const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");
  const source=await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8");
  assert.match(css,/\[dir="rtl"\] \.transaction-workspace > \* \{ direction:rtl; \}/);
  assert.match(css,/\[dir="ltr"\] \.transaction-workspace > \* \{ direction:ltr; \}/);
  assert.match(css,/\.app-shell\[dir="rtl"\][^{]+\{ direction:rtl; text-align:start; \}/);
  assert.match(css,/\.app-shell\[dir="ltr"\][^{]+\{ direction:ltr; text-align:start; \}/);
  assert.match(source,/principalType==="local"\?tr\("دخول مباشر"\):data\.principal\.name/);
});
''', encoding="utf-8")
