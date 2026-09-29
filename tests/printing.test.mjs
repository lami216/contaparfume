import test from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";
const app=readFileSync(new URL("../app/conta-app.tsx",import.meta.url),"utf8"),printing=readFileSync(new URL("../app/printing.ts",import.meta.url),"utf8"),xlsx=readFileSync(new URL("../app/xlsx-export.ts",import.meta.url),"utf8"),css=readFileSync(new URL("../app/printing.css",import.meta.url),"utf8"),globals=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8"),main=readFileSync(new URL("../desktop/main.cjs",import.meta.url),"utf8"),preload=readFileSync(new URL("../desktop/preload.cjs",import.meta.url),"utf8"),pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
test("printing supports one invoice source with three profiles",()=>{for(const profile of ["a4","thermal80","thermal58"])assert.match(printing,new RegExp(`\\"${profile}\\"`));assert.match(app,/function OfficialRecordSheet/);assert.match(app,/data-label=\{presentation\.columns/);assert.match(css,/data-print-profile="thermal80"/);assert.match(css,/data-print-profile="thermal58"/);assert.match(css,/data-print-profile="a4"/)});
test("desktop printing bridge is narrow and packaged",()=>{for(const channel of ["alkarna:printing:list","alkarna:printing:get-settings","alkarna:printing:set-settings","alkarna:printing:print"]){assert.ok(main.includes(channel));assert.ok(preload.includes(channel))}assert.match(main,/getPrintersAsync/);assert.match(main,/event\.sender\.print/);assert.match(main,/silent,printBackground:true/);assert.equal(pkg.build.files.includes("desktop/preload.cjs"),true);assert.doesNotMatch(preload,/require\(['\"](?:node:fs|child_process|node:child_process)/)});
test("automatic printing no longer removes print mode immediately",()=>{assert.match(app,/printPreparedDocument\(await loadPrintSettings\(\), true\)/);assert.doesNotMatch(app,/window\.print\(\); root\.classList\.remove\("print-document-mode"\)/);assert.match(printing,/document\.fonts\?\.ready/);assert.match(printing,/afterprint/)});
test("general settings exposes printer, three previews and test print",()=>{assert.match(app,/function PrintSettingsPanel/);assert.match(app,/PRINT_PROFILES\.map/);assert.match(app,/PrintSettingsPanel branding=\{branding\}/);assert.match(app,/print-profile-preview/);assert.match(app,/printPreparedDocument\(settings,false\)/)});
test("printer choice is device local and defaults to A4 Windows printer",()=>{assert.match(main,/printing-settings\.json/);assert.match(main,/DEFAULT_PRINT_SETTINGS=\{deviceName:null,profile:'a4'\}/);assert.match(printing,/DEFAULT_PRINT_SETTINGS: PrintSettings = \{ deviceName: null, profile: "a4" \}/)});

test("invoice header remains printable",()=>{assert.doesNotMatch(globals,/@media print\s*\{\s*\.sidebar,\s*header,/);assert.match(globals,/@media print\s*\{\s*\.sidebar,\s*\.page-bar,/)});
test("print profile thumbnails show whole sheets and open a large preview",()=>{assert.match(css,/Preview fidelity v2/);assert.match(css,/print-preview-lightbox/);assert.match(css,/translate\(-50%,-50%\) scale/);assert.match(printing,/installPrintProfilePreviewLightbox/);assert.match(printing,/cloneNode\(true\)/)});
test("thermal jobs use real roll widths with measured height and safe fallback",()=>{assert.match(printing,/thermalPaperHeightMicrons/);assert.match(printing,/paperHeightMicrons/);assert.match(main,/thermal80:80000/);assert.match(main,/thermal58:58000/);assert.match(main,/pageSize:\{width:thermalWidth,height:thermalHeight\}/);assert.match(main,/retry print profile=/)});

test("A4 thumbnail is top-anchored and readable while invoice header supports logo plus phones",()=>{assert.match(css,/profile-a4[\s\S]*top:6px!important[\s\S]*scale\(\.165\)/);assert.match(css,/profile-a4[\s\S]*transform-origin:top center!important/);assert.match(app,/official-record-logo/);assert.match(app,/official-brand-phone/);assert.match(app,/storeLogoDataUrl/);assert.match(app,/أرقام الهواتف/)});

test("report printing is portrait, isolated from pagination, and never prints the loading overlay",()=>{
  assert.match(main,/pageSize:'A4',landscape:false/);
  assert.match(globals,/@page report\{size:A4 portrait;margin:10mm 12mm\}/);
  assert.match(globals,/html\.print-report-mode body>\.report-print-portal\{display:block!important\}/);
  assert.match(globals,/\.sidebar,\.page-bar,\.no-print,\.toast,\.report-loading\{display:none!important\}/);
  assert.match(app,/const printable=await fetchReport\(committedPeriod,1,sortState,true\)/);
  assert.match(app,/choice==="printer"\)await printPreparedReport\(\)/);
  assert.match(app,/savePreparedReportPdf\(base\)/);
  assert.match(app,/printResult&&createPortal\(<div className="report-print-portal"/);
  assert.doesNotMatch(app,/setResult\(printable\)[\s\S]{0,220}window\.print\(\)/);
});

test("inventory, movement, and overview printing use dedicated A4 portals",()=>{
  assert.match(printing,/export async function printPreparedWorkspace\(\)/);
  assert.match(printing,/printPreparedTarget\(settings, false, "print-workspace-mode", "\.workspace-print-portal"\)/);
  assert.doesNotMatch(app,/printCurrentPageA4/);
  assert.match(app,/className="workspace-print-portal inventory-print-portal"/);
  assert.match(app,/className="workspace-print-portal movement-print-portal"/);
  assert.match(app,/className="workspace-print-portal overview-print-portal"/);
  assert.equal((app.match(/await printPreparedWorkspace\(\)/g)??[]).length>=3,true);
  assert.match(globals,/html\.print-workspace-mode body>\.workspace-print-portal\{display:block!important\}/);
  assert.match(globals,/\.workspace-print-table thead\{display:table-header-group!important\}/);
  assert.match(globals,/\.inventory-print-table\{font-size:6\.65pt!important/);
});



test("manual output buttons offer printer, direct PDF, and real Excel while automatic invoice printing stays direct",()=>{
  for(const channel of ["alkarna:printing:pdf","alkarna:export:save"]){assert.ok(main.includes(channel));assert.ok(preload.includes(channel))}
  assert.match(main,/printToPDF/);
  assert.match(main,/showSaveDialog/);
  assert.match(app,/function OutputChoiceDialog/);
  for(const label of ["الطباعة بالطابعة","حفظ PDF","تصدير Excel"])assert.ok(app.includes(label));
  assert.match(app,/savePreparedDocumentPdf/);
  assert.match(app,/savePreparedWorkspacePdf/);
  assert.match(app,/savePreparedReportPdf/);
  assert.match(app,/saveExcelFile\(base,createXlsx/);
  assert.match(app,/printPreparedDocument\(await loadPrintSettings\(\), true\)/);
  assert.match(xlsx,/PK|0x04034b50/);
  assert.match(xlsx,/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml/);
});
