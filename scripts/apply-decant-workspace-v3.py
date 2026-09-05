from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:180]!r}")
    write(path, text.replace(old, new, 1))


# Move decant management out of the products navigation and into the invoice workspace.
app = "app/conta-app.tsx"
replace_once(app, 'import PerfumeDivisions from "./perfume-divisions";\n', '')
replace_once(app, '  | "perfumeDivisions"\n', '')
replace_once(app, '  { id: "perfumeDivisions", label: "التقسيمات", icon: Boxes },\n\n', '')
replace_once(app, '''const productNav: Array<{ id: View; label: string; icon: typeof PackagePlus }> = [
  { id: "products", label: "المنتجات", icon: PackagePlus },
  { id: "perfumeDivisions", label: "التقسيمات", icon: Boxes },
];
''', '')
replace_once(app, '    [productMenu, setProductMenu] = useState(false),\n', '')
replace_once(app, '  const productMenuRef = useRef<HTMLDivElement>(null);\n', '')
replace_once(app, 'products:"products.view",perfumeDivisions:"perfume.divisions.view",records:', 'products:"products.view",records:')
replace_once(app, '      if (!productMenuRef.current?.contains(event.target as Node)) setProductMenu(false);\n', '')
replace_once(app, 'setInvoiceMenu(false); setProductMenu(false); setReportMenu(false);', 'setInvoiceMenu(false); setReportMenu(false);')
replace_once(app, 'const closeNavigationMenus = () => { setWarehouseMenu(false); setInvoiceMenu(false); setProductMenu(false); setReportMenu(false);', 'const closeNavigationMenus = () => { setWarehouseMenu(false); setInvoiceMenu(false); setReportMenu(false);')
replace_once(app, '["pos","decantInvoices","purchases","records","products","perfumeDivisions","customers"', '["pos","decantInvoices","purchases","records","products","customers"')
replace_once(app,
'''          <div className="nav-menu nav-products product-nav-menu" ref={productMenuRef}><button className={productNav.some(item=>item.id===view)?"nav active":"nav"} aria-expanded={productMenu} onClick={()=>setProductMenu(value=>!value)}><PackagePlus/><span>{tr("المنتجات")}</span><ChevronDown className="chevron"/></button>{productMenu&&<div className="nav-popover product-nav-popover">{productNav.map(item=><PermissionNavItem key={item.id} allowed={can(viewCapability[item.id])} active={view===item.id} onClick={()=>navigate(item.id)}><span>{tr(item.label)}</span></PermissionNavItem>)}</div>}</div>''',
'''          <PermissionNavItem allowed={can(viewCapability.products)} active={view==="products"} className={`nav ${topNavClass.products}`} onClick={()=>navigate("products")}><PackagePlus/><span>{tr("المنتجات")}</span></PermissionNavItem>''')
replace_once(app, '<DecantInvoicesPage data={data} run={run} openDoc={openDoc} />', '<DecantInvoicesPage data={data} run={run} openDoc={openDoc} onAdjustBottle={openStockAdjustment} />')
replace_once(app, '              {view === "perfumeDivisions" && <PerfumeDivisions data={data} run={run} onAdjustBottle={openStockAdjustment} />}{" "}\n', '')
app_text = read(app)
for obsolete in ['"perfumeDivisions"', 'productMenuRef', 'setProductMenu(', 'productNav.map(']:
    if obsolete in app_text:
        raise SystemExit(f"Obsolete standalone decant navigation remains: {obsolete}")


# Make perfume/decant product selection searchable in the sales invoice.
invoices = "app/perfume-invoices.tsx"
replace_once(invoices, 'import { tr } from "./i18n/messages";\n', 'import { tr } from "./i18n/messages";\nimport PerfumeProductPicker from "./perfume-product-search";\n')
replace_once(invoices,
'''function InvoiceHistory({ documents, openDoc, onVoid, busy }: { documents: DocumentRecord[]; openDoc: (id: string) => void; onVoid: (document: DocumentRecord) => void; busy: boolean }) {''',
'''function InvoiceHistory({ documents, openDoc, onVoid, busy, title, emptyText }: { documents: DocumentRecord[]; openDoc: (id: string) => void; onVoid: (document: DocumentRecord) => void; busy: boolean; title: string; emptyText: string }) {''')
replace_once(invoices, '<h3>{tr("آخر فواتير التقسيمات")}</h3>', '<h3>{title}</h3>')
replace_once(invoices, '<tr><td colSpan={6}>{tr("لا توجد فواتير تقسيمات حتى الآن")}</td></tr>', '<tr><td colSpan={6}>{emptyText}</td></tr>')
replace_once(invoices,
'''      <div className="decant-add-row"><label>{tr("المنتج أو الزجاجة")}<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">{tr("اختر منتج التقسيمات")}</option><optgroup label={tr("عطور التقسيمات")}>{decants.map(product => <option key={product.id} value={product.id} disabled={stockInWarehouse(product, warehouseId) <= 0}>{product.name} — {quantity(stockInWarehouse(product, warehouseId))}</option>)}</optgroup><optgroup label={tr("زجاج التقسيمات")}>{bottles.map(product => <option key={product.id} value={product.id} disabled={stockInWarehouse(product, warehouseId) <= 0}>{product.name} — {quantity(stockInWarehouse(product, warehouseId))}</option>)}</optgroup></select></label><button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button></div>''',
'''      <div className="decant-add-row"><label>{tr("المنتج أو الزجاجة")}<PerfumeProductPicker products={saleProducts} value={productId} onChange={setProductId} placeholder={tr("اختر منتج التقسيمات")} searchPlaceholder={tr("ابحث عن عطر تقسيمات أو زجاجة")} getMeta={product => `${product.perfumeForm === "decant" ? tr("عطور التقسيمات") : tr("زجاج التقسيمات")} · ${tr("المتوفر")}: ${quantity(stockInWarehouse(product, warehouseId))}`} isDisabled={product => stockInWarehouse(product, warehouseId) <= 0}/></label><button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button></div>''')
replace_once(invoices,
'<InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>',
'<InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy} title={tr("آخر فواتير التقسيمات")} emptyText={tr("لا توجد فواتير تقسيمات حتى الآن")}/>')
replace_once(invoices,
'<InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>',
'<InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy} title={tr("آخر فواتير شراء زجاج التقسيمات")} emptyText={tr("لا توجد فواتير شراء زجاج حتى الآن")}/>')


# Add Arabic/French labels for the consolidated workspace and search banners.
messages = "app/i18n/messages.ts"
text = read(messages)
ar_anchor = '  "فواتير التقسيمات": "فواتير التقسيمات",'
fr_anchor = '  "فواتير التقسيمات": "Factures de décants",'
ar_lines = '''
  "إدارة التقسيمات": "إدارة التقسيمات",
  "حوّل العطور، عرّف زجاج التقسيمات وأرجع الباقي إلى عطر ناقص.": "حوّل العطور، عرّف زجاج التقسيمات وأرجع الباقي إلى عطر ناقص.",
  "ابحث عن عطر تقسيمات أو زجاجة": "ابحث عن عطر تقسيمات أو زجاجة",
  "ابحث عن العطر بالاسم أو الكود أو الباركود": "ابحث عن العطر بالاسم أو الكود أو الباركود",
  "آخر فواتير شراء زجاج التقسيمات": "آخر فواتير شراء زجاج التقسيمات",
  "لا توجد فواتير شراء زجاج حتى الآن": "لا توجد فواتير شراء زجاج حتى الآن",'''
fr_lines = '''
  "إدارة التقسيمات": "Gestion des décants",
  "حوّل العطور، عرّف زجاج التقسيمات وأرجع الباقي إلى عطر ناقص.": "Transformez les parfums, gérez les flacons et reconstituez le reste.",
  "ابحث عن عطر تقسيمات أو زجاجة": "Rechercher un décant ou un flacon",
  "ابحث عن العطر بالاسم أو الكود أو الباركود": "Rechercher le parfum par nom, code ou code-barres",
  "آخر فواتير شراء زجاج التقسيمات": "Derniers achats de flacons",
  "لا توجد فواتير شراء زجاج حتى الآن": "Aucun achat de flacons pour le moment",'''
if '"إدارة التقسيمات": "إدارة التقسيمات"' not in text:
    if ar_anchor not in text or fr_anchor not in text:
        raise SystemExit("Decant translation anchors not found")
    text = text.replace(ar_anchor, ar_anchor + ar_lines, 1)
    text = text.replace(fr_anchor, fr_anchor + fr_lines, 1)
write(messages, text)


# Replace the previous workspace overrides with a balanced two-column desktop layout and search popover styling.
css = "app/globals.css"
css_text = read(css)
marker = "/* unified-decant-invoice-hub */"
if marker not in css_text:
    raise SystemExit("Unified decant workspace CSS marker not found")
css_text = css_text[:css_text.index(marker)] + '''/* unified-decant-invoice-hub */
.section-decantInvoices { --section-color: var(--color-invoices, #0b6d67); --section-soft: #eaf7f5; }
.decant-invoices-hub { display:grid; grid-template-rows:auto minmax(0,1fr); gap:7px; width:100%; height:100%; min-height:0; overflow:hidden; }
.decant-invoice-modebar { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:52px; padding:6px 8px; border:1px solid var(--border,#d0d5dd); border-radius:9px; background:var(--panel,#fff); box-shadow:0 3px 12px rgba(15,23,42,.04); }
.decant-invoice-mode-tabs { display:grid; grid-template-columns:repeat(3,minmax(155px,1fr)); gap:4px; width:min(760px,70%); min-width:560px; padding:3px; border:1px solid #cfe3df; border-radius:7px; background:#f4faf9; }
.decant-mode-tab { display:flex; align-items:center; justify-content:center; gap:6px; min-height:35px; padding:4px 8px; border:0; border-radius:5px; color:#52605e; background:transparent; font-weight:800; font-size:10px; cursor:pointer; }
.decant-mode-tab svg { width:15px; height:15px; }
.decant-mode-tab.active { color:#fff; background:var(--section-color,#0b6d67); box-shadow:0 2px 7px rgba(11,109,103,.18); }
.decant-invoice-mode-help { flex:1; margin:0; color:var(--muted,#667085); font-size:9px; line-height:1.4; text-align:start; }
.decant-invoices-hub-body { min-width:0; min-height:0; overflow:hidden; }
.decant-invoices-hub-body:not(.is-management) > .decant-invoice-page { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr); gap:8px; height:100%; min-height:0; overflow:hidden; }
.decant-invoices-hub-body:not(.is-management) .decant-invoice-editor,
.decant-invoices-hub-body:not(.is-management) .decant-invoice-history { height:100%; min-height:0; }
.decant-invoices-hub .decant-invoice-editor { gap:5px; padding:7px; }
.decant-invoices-hub .decant-invoice-history { padding:7px; }
.decant-invoices-hub .decant-invoice-heading h2 { font-size:13px; }
.decant-invoices-hub .decant-invoice-heading h3 { font-size:12px; }
.decant-invoices-hub .decant-invoice-heading > strong { font-size:14px; }
.decant-invoices-hub .decant-lines-table { min-width:570px; }
.decant-invoices-hub .decant-invoice-history-table { min-width:500px; }
.decant-invoices-hub .decant-lines-table th,
.decant-invoices-hub .decant-lines-table td,
.decant-invoices-hub .decant-invoice-history-table th,
.decant-invoices-hub .decant-invoice-history-table td { height:27px; padding:2px 3px; }
.decant-invoices-hub-body.is-management > .perfume-divisions-page { height:100%; min-height:0; }

.perfume-search-picker { position:relative; min-width:0; display:grid; gap:2px; }
.perfume-search-input-shell { display:flex; align-items:center; gap:5px; height:31px; min-height:31px; padding:0 6px; border:1px solid var(--border,#d0d5dd); border-radius:5px; background:#fff; transition:border-color .12s ease,box-shadow .12s ease; }
.perfume-search-input-shell:focus-within { border-color:var(--section-color,#0b6d67); box-shadow:0 0 0 2px color-mix(in srgb,var(--section-color,#0b6d67) 18%,transparent); }
.perfume-search-input-shell > svg { width:15px; height:15px; flex:0 0 auto; color:var(--muted,#667085); }
.perfume-search-input-shell input { width:100%; min-width:0; height:28px; min-height:28px; padding:0; border:0!important; outline:0; box-shadow:none!important; background:transparent; font-size:10px; }
.perfume-search-clear { display:grid; place-items:center; width:23px; height:23px; min-height:23px; padding:0; border:0; border-radius:4px; background:transparent; color:var(--muted,#667085); cursor:pointer; }
.perfume-search-clear:hover { background:#eef4f3; }
.perfume-search-clear svg { width:13px; height:13px; }
.perfume-search-hint { display:none; }
.perfume-search-results { overflow:auto; overscroll-behavior:contain; padding:4px; border:1px solid #bcc9cf; border-radius:7px; background:#fff; box-shadow:0 12px 28px rgba(15,23,42,.18); }
.perfume-search-results button { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; width:100%; min-height:34px; padding:5px 8px; border:0; border-radius:5px; background:transparent; color:var(--text,#172033); text-align:start; cursor:pointer; }
.perfume-search-results button span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:800; }
.perfume-search-results button small { color:var(--muted,#667085); font-size:8px; white-space:nowrap; }
.perfume-search-results button:hover,.perfume-search-results button.highlighted { background:#edf7f5; }
.perfume-search-results button.selected { background:#e2f2ef; }
.perfume-search-results button:disabled { opacity:.45; cursor:not-allowed; }
.perfume-search-empty { padding:12px; color:var(--muted,#667085); text-align:center; font-size:10px; }

@media(max-width:1050px){
  .decant-invoices-hub { height:auto; min-height:100%; overflow:visible; }
  .decant-invoice-modebar { align-items:stretch; flex-direction:column; }
  .decant-invoice-mode-tabs { width:100%; min-width:0; }
  .decant-invoices-hub-body { overflow:visible; }
  .decant-invoices-hub-body:not(.is-management) > .decant-invoice-page { grid-template-columns:1fr; grid-template-rows:auto auto; height:auto; overflow:visible; }
  .decant-invoices-hub-body:not(.is-management) .decant-invoice-editor,
  .decant-invoices-hub-body:not(.is-management) .decant-invoice-history { height:auto; }
}
@media(max-width:680px){
  .decant-invoice-mode-tabs { grid-template-columns:1fr; }
}
'''
write(css, css_text)


# Update navigation and workspace tests to the new information architecture.
nav_test = "tests/navigation.test.mjs"
text = read(nav_test)
text = text.replace(
    'test("desktop navigation has eight unique top-level destinations with products grouping perfume divisions",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")),match=source.match(/MAIN_NAV_ORDER = \\[([^\\]]+)\\]/);assert.ok(match);const entries=[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(entries,["pos","invoices","warehouses","products","parties","banks","reports","settings"]);assert.equal(new Set(entries).size,entries.length);assert.match(source,/const productNav:[\\s\\S]*?id: "products"[\\s\\S]*?id: "perfumeDivisions"/);});',
    'test("desktop navigation keeps products direct and decant management inside invoices",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")),match=source.match(/MAIN_NAV_ORDER = \\[([^\\]]+)\\]/);assert.ok(match);const entries=[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(entries,["pos","invoices","warehouses","products","parties","banks","reports","settings"]);assert.equal(new Set(entries).size,entries.length);assert.doesNotMatch(source,/id: "perfumeDivisions"/);assert.match(source,/active=\\{view==="products"\\}[^>]*onClick=\\{\\(\\)=>navigate\\("products"\\)\\}/);});'
)
text = text.replace('  assert.match(source, /productNav\\.map\\(item=><PermissionNavItem[^>]+active=\\{view===item\\.id\\}/);\n', '')
text = text.replace('  for (const collection of ["invoiceNav", "warehouseNav", "partyNav", "productNav", "bankNav", "reportOrder"])', '  for (const collection of ["invoiceNav", "warehouseNav", "partyNav", "bankNav", "reportOrder"])')
text = text.replace('  assert.equal((source.match(/className="nav-popover(?: [^"]+)?"/g) ?? []).length, 7);', '  assert.equal((source.match(/className="nav-popover(?: [^"]+)?"/g) ?? []).length, 6);')
text = text.replace('  assert.match(source, /className="nav-menu nav-products product-nav-menu"[\\s\\S]*?<PackagePlus\\s*\\/>\\s*<span>المنتجات<\\/span>\\s*<ChevronDown/);', '  assert.match(source, /active=\\{view==="products"\\}[\\s\\S]{0,180}<PackagePlus\\s*\\/>\\s*<span>\\{tr\\("المنتجات"\\)\\}<\\/span>/);')
text = text.replace('  assert.match(source, /productMenuRef/);\n  assert.match(source, /setProductMenu\\(false\\)/);\n', '')
write(nav_test, text)

hub_test = "tests/decant-invoice-hub.test.mjs"
write(hub_test, '''import assert from "node:assert/strict";\nimport test from "node:test";\nimport { readFile } from "node:fs/promises";\n\nconst source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");\n\ntest("decant commercial and management work live in one invoice workspace", async () => {\n  const [app, hub, invoices, divisions, picker, css] = await Promise.all([\n    source("app/conta-app.tsx"), source("app/decant-invoices-page.tsx"), source("app/perfume-invoices.tsx"),\n    source("app/perfume-divisions.tsx"), source("app/perfume-product-search.tsx"), source("app/globals.css"),\n  ]);\n  assert.match(app, /id: "decantInvoices", label: "فواتير التقسيمات"/);\n  assert.match(app, /view === "decantInvoices" && <DecantInvoicesPage[^>]+onAdjustBottle=\\{openStockAdjustment\\}/);\n  assert.doesNotMatch(app, /id: "perfumeDivisions"/);\n  assert.match(hub, /DecantSaleInvoice/);\n  assert.match(hub, /DecantBottlePurchaseInvoice/);\n  assert.match(hub, /PerfumeDivisions/);\n  assert.match(hub, /mode === "management"/);\n  assert.match(hub, /إدارة التقسيمات/);\n  assert.match(invoices, /PerfumeProductPicker products=\\{saleProducts\\}/);\n  assert.match(divisions, /PerfumeProductPicker products=\\{sourceProducts\\}/);\n  assert.match(picker, /role="combobox"/);\n  assert.match(picker, /product\\.barcode/);\n  assert.match(css, /grid-template-columns:minmax\\(0,1fr\\) minmax\\(0,1fr\\)/);\n  assert.match(css, /\\.perfume-search-results\\s*\\{/);\n});\n''')

print("Decant workspace v3 patch applied")
