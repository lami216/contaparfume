import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizePresentationSource } from "./presentation-source.mjs";
test("desktop navigation has eight unique destinations with reports before settings",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")),match=source.match(/MAIN_NAV_ORDER = \[([^\]]+)\]/);assert.ok(match);const entries=[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(entries,["pos","invoices","warehouses","products","parties","banks","reports","settings"]);assert.equal(new Set(entries).size,entries.length);});

test("submenu current states require their parent view without resetting remembered selections", async () => {
  const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));

  assert.match(source, /allowed=\{can\(bankTabCapability\[item\.id\]\)\} active=\{view==="banks"&&effectiveBankTab===item\.id\}/);
  assert.match(source, /allowed=\{can\("reports\.view"\)\} active=\{view==="reports"&&reportType===id\}/);
  assert.match(source, /allowed=\{settingsAllowed\(item\.id\)\} active=\{view==="settings"&&settingsTab===item\.id\}/);
  assert.match(source, /invoiceNav\.map\(n=><PermissionNavItem[^>]+active=\{view===n\.id\}/);
  assert.match(source, /warehouseNav\.map\(n=><PermissionNavItem[^>]+active=\{view===n\.id\}/);
  assert.match(source, /partyNav\.map\(item=><PermissionNavItem[^>]+active=\{view===item\.id\}/);

  const navigateBody = source.match(/const navigate = (?:async )?\(id: View, options: \{ replaceEditor\?: boolean \} = \{\}\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(navigateBody);
  assert.doesNotMatch(navigateBody, /setBankTab|setReportType/);
});

test("permission-aware navigation stays complete and disabled items cannot activate", async () => {
  const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
  for (const collection of ["invoiceNav", "warehouseNav", "partyNav", "bankNav", "reportOrder"])
    assert.match(source, new RegExp(`${collection}\\.map\\(`));
  assert.doesNotMatch(source, /(?:invoiceNav|warehouseNav|partyNav)\.filter\([^\n]*can/);
  assert.match(source, /if \(!canView\(id\)\) return false/);
  assert.match(source, /disabled=\{!allowed\}/);
  assert.match(source, /aria-disabled=\{!allowed\?"true":undefined\}/);
  assert.match(source, /allowed&&active/);
  assert.match(source, /لا تملك صلاحية الوصول/);
});

test("top navigation dropdowns share one visual system and render text-only rows", async () => {
  const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.equal((source.match(/className="nav-popover(?: [^"]+)?"/g) ?? []).length, 6);
  assert.match(source, /<ReceiptText\s*\/>\s*<span>الفواتير<\/span>\s*<ChevronDown/);
  assert.match(source, /<Boxes\s*\/>\s*<span>المخازن<\/span>\s*<ChevronDown/);
  assert.match(source, /<Users\s*\/>\s*<span>العملاء والموردون<\/span>\s*<ChevronDown/);
  assert.match(source, /<Landmark\s*\/>\s*<span>البنوك<\/span>\s*<ChevronDown/);
  assert.match(source, /<Receipt\s*\/>\s*<span>التقارير<\/span>\s*<ChevronDown/);
  assert.match(source, /className="nav-menu settings-nav-menu"[\s\S]*?<SettingsIcon\s*\/>\s*<span>الإعدادات<\/span>\s*<ChevronDown/);
  assert.match(source, /\[\{id:"general",label:"إعدادات عامة"\},\{id:"users",label:"المستخدمون والصلاحيات"\},\{id:"data",label:"البيانات والنسخ الاحتياطي"\},\{id:"license",label:"رخصة التفعيل"\},\{id:"contact",label:"تواصل مع الدعم"\}\]/);
  assert.match(source, /const settingsAllowed=.*settings\.users\.manage.*settings\.backup\.manage.*settings\.legacy\.import/);
  assert.match(source, /settingsMenuRef/);
  assert.match(source, /setSettingsMenu\(false\)/);

  assert.doesNotMatch(source, /invoiceNav\.filter[^\n]+<n\.icon\s*\/>/);
  assert.doesNotMatch(source, /warehouseNav\.filter[^\n]+<n\.icon\s*\/>/);
  assert.doesNotMatch(source, /partyNav\.filter[^\n]+<item\.icon\s*\/>/);

  assert.match(css, /--nav-popover-hover:\s*#1967d2/);
  assert.match(css, /--nav-popover-active:\s*#172d55/);
  assert.match(css, /\.nav-menu\s*>\s*\.nav-popover button\s*\{[^}]*height:\s*36px[^}]*min-height:\s*36px[^}]*padding:\s*0 12px[^}]*border-radius:\s*0/s);
  assert.match(css, /\.nav-menu\s*>\s*\.nav-popover button\.active\s*\{[^}]*background:\s*var\(--nav-popover-active\)/s);
  assert.match(css, /\.nav-menu\s*>\s*\.nav-popover button:hover,[^\{]*button:focus-visible\s*\{[^}]*background:\s*var\(--nav-popover-hover\)/s);
  assert.match(css, /\.nav-menu\s*>\s*\.report-nav-popover\s*\{[^}]*max-height:[^;}]+;overflow-y:\s*auto/s);
  assert.doesNotMatch(css, /\.(?:bank|report)-nav-popover button(?::hover|\.active)/);
});

test("product and report tables use uncapped shared scroll viewports", async () => {
  const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /slice\(0,\s*20\)/);
  assert.match(source, /FramedSection title="قائمة المنتجات" className="scroll-panel product-management"[\s\S]{0,160}erp-table-wrap product-table-viewport/);
  assert.match(css, /product-table-viewport\{height:100%;overflow:auto;contain:paint;background:#fff\}/);
  assert.match(css, /erp-table thead th\{background:var\(--section-color\);background-clip:padding-box\}/);
});

test("party ledger filters real compatible roles and transient documents overlay mounted content", async () => {
  const source = normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx", import.meta.url), "utf8"));
  assert.match(source, /filter\(p=>resolvePartyType\(p\)===partyTypeFilter\)/);
  assert.match(source, /search:`\$\{p\.name\} \$\{p\.phone\?\?""\}`/);
  assert.match(source, /setPartyTypeFilter\("supplier"\);setPartyId\(""\);setResult\(null\)/);
  assert.doesNotMatch(source, /\) : doc \? \(/);
  assert.match(source, /\{doc && <div className="modal-overlay"/);
});


test("bank movement-only permission has its own navigation gate",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));assert.match(source,/movements:"banks\.movements\.view"/);assert.match(source,/const canView=.*id==="banks".*bankNav\.some/);});

test("traceable records open details first and expose a source-navigation action",async()=>{
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/function DocumentDetail\([^)]*onSource/);
  assert.match(source,/onSource&&!onEdit&&<button className="primary" onClick=\{onSource\}>الانتقال إلى المصدر<\/button>/);
  assert.match(source,/const openDocumentSource = async \(document: DocumentRecord\)/);
  for(const mapping of [
    /document\.kind==="sale"[\s\S]*?navigate\("pos",\{replaceEditor:edit\}\)/,
    /document\.kind==="purchase"[\s\S]*?navigate\("purchases",\{replaceEditor:edit\}\)/,
    /document\.kind==="expense"[\s\S]*?navigate\("expenses",\{replaceEditor:edit\}\)/,
    /document\.kind==="payment"[\s\S]*?setPartyDetail\(party\)/,
    /document\.kind==="transfer"[\s\S]*?navigate\("transfers",\{replaceEditor:edit\}\)/,
    /document\.kind==="adjustment"[\s\S]*?navigate\("adjustments",\{replaceEditor:edit\}\)/,
    /document\.kind==="account-transfer"[\s\S]*?setBankTab\("transfers"\)/,
    /document\.kind==="account-adjustment"[\s\S]*?setBankTab\("adjustment"\)/,
  ]) assert.match(source,mapping);
  assert.match(source,/stockRows\.map\(row=><tr key=\{row\.id\} onClick=\{\(\)=>row\.documentId&&openDoc\(row\.documentId\)\}/);
  assert.match(source,/financialRows\.map\(row=><tr key=\{row\.id\} onClick=\{\(\)=>row\.documentId&&openDoc\(row\.documentId\)\}/);
  assert.match(source,/fallbackMovements\.map\(movement=><tr[^>]+onClick=\{\(\)=>movement\.documentId&&openDoc\(movement\.documentId\)\}/);
});


test("expense history follows the universal detail-then-source flow",async()=>{
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/sortedExpenses\.map\(document=><tr key=\{document\.id\} onClick=\{\(\)=>openDoc\(document\.id\)\}/);
  assert.match(source,/document\.kind==="expense"[\s\S]*?navigate\("expenses",\{replaceEditor:edit\}\)[\s\S]*?setExpenseEditRequest\(document\.id\)/);
});


test("source navigation only mutates the destination after permission and dirty-editor guards succeed", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/const navigate = async \(id: View, options: \{ replaceEditor\?: boolean \} = \{\}\)/);
  assert.match(source,/if \(!canView\(id\)\) return false/);
  assert.match(source,/!await confirmAction\([^;]+\)\)\s*return false/);
  assert.match(source,/return true;/);
  assert.match(source,/if\(!await navigate\("reports"\)\)return;setReportType/);
  assert.match(source,/if\(await navigate\(targetView\)\)setPartyDetail\(party\)/);
  assert.match(source,/navigate\("pos",\{replaceEditor:edit\}\)/);
  assert.match(source,/navigate\("purchases",\{replaceEditor:edit\}\)/);
  assert.match(source,/navigate\("expenses",\{replaceEditor:edit\}\)/);
});

test("new invoice and expense drafts participate in the unsaved-change guard", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.ok((source.match(/isEditing: \(\) => Boolean\(editingDocumentId\) \|\| dirty\(\)/g)??[]).length>=2);
  assert.match(source,/dirty=\(\)=>editingExpenseId\?snapshot\(\)!==baseline\.current:Boolean\(title\.trim\(\)\|\|amount\|\|paymentMethod\)/);
  assert.match(source,/isEditing:\(\)=>Boolean\(editingExpenseId\)\|\|dirty\(\)/);
});

test("bank movement detail falls back locally when its source document is outside the user's visible document set", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/documentVisible=Boolean\(movement\.documentId&&data\.documents\.some\(document=>document\.id===movement\.documentId\)\)/);
  assert.match(source,/if\(documentBacked&&documentVisible\)\{void openDoc\(movement\.documentId\);return\}setDetail/);
});

test("print-after-save never mounts a printable document from a missing bootstrap row", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/const autoPrintDocument=autoPrintId\?data\.documents\.find\(document=>document\.id===autoPrintId\)\?\?null:null/);
  assert.match(source,/\{autoPrintDocument && <PrintableDocument document=\{autoPrintDocument\} data=\{data\} \/>\}/);
  assert.doesNotMatch(source,/data\.documents\.find\(document => document\.id === autoPrintId\)!/);
});


test("party, stock, and bank transaction drafts register with the shared unsaved-change guard", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/function PartyPage\([^)]*registerEditorGuard/);
  assert.match(source,/isEditing:\(\)=>Boolean\(editingPaymentId\)\|\|paymentDirty\(\)/);
  assert.match(source,/function MultiStockForm[\s\S]*registerEditorGuard: RegisterEditorGuard/);
  assert.match(source,/isEditing:\(\)=>Boolean\(editingDocument\)\|\|draftDirty\(\)/);
  assert.match(source,/function Banks\([^)]*registerEditorGuard/);
  assert.match(source,/tab==="transfers"\)registerEditorGuard/);
  assert.match(source,/tab==="adjustment"\)registerEditorGuard/);
});


test("local edit actions and same-view bank tab changes cannot replace a dirty editor without confirmation", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/const prepareEditorReplacement = async \(\) =>/);
  assert.match(source,/if \(\(id !== view \|\| options\.replaceEditor\) && !await prepareEditorReplacement\(\)\) return false/);
  assert.match(source,/const startEdit=async\(document:DocumentRecord\)=>\{if\(await p\.prepareEditorReplacement\(\)\)setEditing\(document\)\}/);
  assert.match(source,/const startTransferEdit=async\([^\n]+prepareEditorReplacement\(\)\)loadTransfer/);
  assert.match(source,/const startAdjustmentEdit=async\([^\n]+prepareEditorReplacement\(\)\)loadAdjustment/);
  assert.match(source,/\(view==="banks"&&item\.id===effectiveBankTab\)\|\|await navigate\("banks",\{replaceEditor:true\}\)/);
});

test("menu destination state changes only after guarded navigation succeeds", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  assert.match(source,/if\(await navigate\("reports"\)\)setReportType\(id\)/);
  assert.match(source,/if\(await navigate\("settings"\)\)setSettingsTab\(item\.id\)/);
  assert.match(source,/if\(!await prepareEditorReplacement\(\)\)return;setSettingsTab\(item\.id\);setView\("settings"\)/);
});


test("payment accounts never short-circuit bank navigation when selected from another workspace", async () => {
  const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8"));
  const bankMenu=source.match(/bankNav\.map\(item=><PermissionNavItem[\s\S]*?<span>\{tr\(item\.label\)\}<\/span><\/PermissionNavItem>\)/)?.[0]??"";
  assert.match(bankMenu,/\(view==="banks"&&item\.id===effectiveBankTab\)\|\|await navigate\("banks",\{replaceEditor:true\}\)/);
  assert.doesNotMatch(bankMenu,/if\(item\.id===effectiveBankTab\|\|await navigate\("banks"/);
});
