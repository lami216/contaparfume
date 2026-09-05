from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

root = Path(__file__).resolve().parents[1]
app_path = root / "app" / "conta-app.tsx"
test_path = root / "tests" / "navigation.test.mjs"
css_path = root / "app" / "perfume-ui-fixes.css"

app = app_path.read_text(encoding="utf-8")
app = replace_once(app, 'import PerfumeDivisions from "./perfume-divisions";\n', '', 'remove standalone divisions import')
app = replace_once(app, '  | "products"\n  | "perfumeDivisions"\n  | "records"', '  | "products"\n  | "records"', 'remove standalone divisions view')
app = replace_once(app, '  { id: "products", label: "المنتجات", icon: PackagePlus },\n  { id: "perfumeDivisions", label: "التقسيمات", icon: Boxes },\n\n  { id: "banks",', '  { id: "products", label: "المنتجات", icon: PackagePlus },\n\n  { id: "banks",', 'remove divisions nav metadata')
app = replace_once(app, 'const productNav: Array<{ id: View; label: string; icon: typeof PackagePlus }> = [\n  { id: "products", label: "المنتجات", icon: PackagePlus },\n  { id: "perfumeDivisions", label: "التقسيمات", icon: Boxes },\n];\n', '', 'remove product submenu model')
app = replace_once(app, '    [warehouseMenu, setWarehouseMenu] = useState(false),\n    [productMenu, setProductMenu] = useState(false),\n    [reportMenu, setReportMenu] = useState(false),', '    [warehouseMenu, setWarehouseMenu] = useState(false),\n    [reportMenu, setReportMenu] = useState(false),', 'remove product menu state')
app = replace_once(app, '  const invoiceMenuRef = useRef<HTMLDivElement>(null);\n  const productMenuRef = useRef<HTMLDivElement>(null);\n  const reportMenuRef', '  const invoiceMenuRef = useRef<HTMLDivElement>(null);\n  const reportMenuRef', 'remove product menu ref')
app = replace_once(app, 'products:"products.view",perfumeDivisions:"perfume.divisions.view",records:', 'products:"products.view",records:', 'remove standalone divisions capability')
app = replace_once(app, '      if (!invoiceMenuRef.current?.contains(event.target as Node)) setInvoiceMenu(false);\n      if (!productMenuRef.current?.contains(event.target as Node)) setProductMenu(false);\n      if (!reportMenuRef.current?.contains(event.target as Node)) setReportMenu(false);', '      if (!invoiceMenuRef.current?.contains(event.target as Node)) setInvoiceMenu(false);\n      if (!reportMenuRef.current?.contains(event.target as Node)) setReportMenu(false);', 'remove product outside-click handler')
app = replace_once(app, 'setMenu(false); setWarehouseMenu(false); setInvoiceMenu(false); setProductMenu(false); setReportMenu(false);', 'setMenu(false); setWarehouseMenu(false); setInvoiceMenu(false); setReportMenu(false);', 'remove product close from navigate')
app = replace_once(app, 'const closeNavigationMenus = () => { setWarehouseMenu(false); setInvoiceMenu(false); setProductMenu(false); setReportMenu(false);', 'const closeNavigationMenus = () => { setWarehouseMenu(false); setInvoiceMenu(false); setReportMenu(false);', 'remove product close helper')
app = replace_once(app, '["pos","decantInvoices","purchases","records","products","perfumeDivisions","customers"', '["pos","decantInvoices","purchases","records","products","customers"', 'remove divisions fallback route')
old_product_nav = '<div className="nav-menu nav-products product-nav-menu" ref={productMenuRef}><button className={productNav.some(item=>item.id===view)?"nav active":"nav"} aria-expanded={productMenu} onClick={()=>setProductMenu(value=>!value)}><PackagePlus/><span>{tr("المنتجات")}</span><ChevronDown className="chevron"/></button>{productMenu&&<div className="nav-popover product-nav-popover">{productNav.map(item=><PermissionNavItem key={item.id} allowed={can(viewCapability[item.id])} active={view===item.id} onClick={()=>navigate(item.id)}><span>{tr(item.label)}</span></PermissionNavItem>)}</div>}</div>'
new_product_nav = '<PermissionNavItem allowed={can(viewCapability.products)} active={view==="products"} className="nav nav-products" onClick={()=>navigate("products")}><PackagePlus/><span>{tr("المنتجات")}</span></PermissionNavItem>'
app = replace_once(app, old_product_nav, new_product_nav, 'make products direct navigation')
app = replace_once(app, '              {view === "products" && <Products data={data} run={run} />}{" "}\n              {view === "perfumeDivisions" && <PerfumeDivisions data={data} run={run} onAdjustBottle={openStockAdjustment} />}{" "}\n', '              {view === "products" && <Products data={data} run={run} />}{" "}\n', 'remove standalone divisions rendering')
app_path.write_text(app, encoding="utf-8")

test = test_path.read_text(encoding="utf-8")
test = replace_once(test,
'''test("desktop navigation has eight unique top-level destinations with products grouping perfume divisions",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")),match=source.match(/MAIN_NAV_ORDER = \\[([^\\]]+)\\]/);assert.ok(match);const entries=[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(entries,["pos","invoices","warehouses","products","parties","banks","reports","settings"]);assert.equal(new Set(entries).size,entries.length);assert.match(source,/const productNav:[\\s\\S]*?id: "products"[\\s\\S]*?id: "perfumeDivisions"/);});''',
'''test("desktop navigation has eight unique top-level destinations with products as a direct destination",async()=>{const source=normalizePresentationSource(await readFile(new URL("../app/conta-app.tsx",import.meta.url),"utf8")),match=source.match(/MAIN_NAV_ORDER = \\[([^\\]]+)\\]/);assert.ok(match);const entries=[...match[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(entries,["pos","invoices","warehouses","products","parties","banks","reports","settings"]);assert.equal(new Set(entries).size,entries.length);assert.doesNotMatch(source,/const productNav:/);assert.match(source,/allowed=\\{can\\(viewCapability\\.products\\)\\} active=\\{view==="products"\\} className="nav nav-products" onClick=\\{\\(\\)=>navigate\\("products"\\)\\}/);});''',
'update top navigation test')
test = replace_once(test, '  assert.match(source, /productNav\\.map\\(item=><PermissionNavItem[^>]+active=\\{view===item\\.id\\}/);\n', '', 'remove submenu state assertion')
test = replace_once(test, '  for (const collection of ["invoiceNav", "warehouseNav", "partyNav", "productNav", "bankNav", "reportOrder"])', '  for (const collection of ["invoiceNav", "warehouseNav", "partyNav", "bankNav", "reportOrder"])', 'remove productNav collection requirement')
test = replace_once(test, '  assert.equal((source.match(/className="nav-popover(?: [^"]+)?"/g) ?? []).length, 7);', '  assert.equal((source.match(/className="nav-popover(?: [^"]+)?"/g) ?? []).length, 6);', 'update dropdown count')
test = replace_once(test, '  assert.match(source, /className="nav-menu nav-products product-nav-menu"[\\s\\S]*?<PackagePlus\\s*\\/>\\s*<span>المنتجات<\\/span>\\s*<ChevronDown/);', '  assert.match(source, /className="nav nav-products"[\\s\\S]{0,160}<PackagePlus\\s*\\/>\\s*<span>المنتجات<\\/span>/);\n  assert.doesNotMatch(source, /product-nav-menu|product-nav-popover|productMenuRef|setProductMenu/);', 'assert direct products navigation')
test = replace_once(test, '  assert.match(source, /productMenuRef/);\n  assert.match(source, /setProductMenu\\(false\\)/);\n', '', 'remove product menu cleanup assertions')
test_path.write_text(test, encoding="utf-8")

css = r'''/* Perfume edition UI corrections loaded after globals.css. */

@media (min-width: 1051px) {
  :root {
    --app-nav-height: 102px;
    --page-bar-height: 54px;
  }

  .app-shell {
    grid-template-rows: var(--app-nav-height) minmax(0, 1fr);
  }

  .sidebar {
    grid-row: 1;
    position: relative;
    inset: auto;
    width: 100%;
    height: var(--app-nav-height);
    min-height: 0;
    display: flex;
    align-items: center;
    gap: 26px;
    padding: 12px 24px;
  }

  .sidebar nav {
    display: flex;
    align-items: center;
    gap: 4px;
    width: auto;
    min-width: 0;
    flex: 1;
    overflow: visible;
  }

  .sidebar nav > *,
  .nav-menu,
  .nav-menu > .nav {
    width: auto;
    min-width: max-content;
  }

  .nav {
    justify-content: flex-start;
    width: auto;
    min-width: max-content;
    min-height: 56px;
    padding: 9px 11px;
    gap: 11px;
    border-radius: 13px;
    font-size: 12px;
  }

  .nav svg { width: 19px; height: 19px; }
  .party-nav-menu > .nav > span { white-space: nowrap; line-height: normal; text-align: start; overflow-wrap: normal; }

  .brand { gap: 10px; padding: 0; }
  .brand-logo { width: 44px; height: 44px; flex: 0 0 44px; }
  .brand strong { font-size: 29px; line-height: 1; }
  .brand span { font-size: 10px; }
  .account-session { min-width: max-content; }

  .app-shell > main {
    grid-row: 2;
    grid-template-rows: var(--page-bar-height) minmax(0, 1fr);
    height: 100%;
  }

  .app-shell header.page-bar {
    min-height: var(--page-bar-height);
    height: var(--page-bar-height);
    padding: 7px 24px;
  }

  .page-bar h1 { font-size: clamp(20px, 1.7vw, 26px); }

  /* Decant workspace: fixed header and a true 50/50 editor/history desktop split. */
  .decant-invoices-hub {
    display: grid;
    grid-template-rows: 50px minmax(0, 1fr);
    gap: 7px;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .decant-invoice-modebar {
    box-sizing: border-box;
    height: 50px;
    min-height: 50px;
    padding: 4px 7px;
    gap: 10px;
    overflow: hidden;
  }

  .decant-invoice-mode-tabs {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: min(710px, 66%);
    min-width: 500px;
    gap: 4px;
    padding: 2px;
  }

  .decant-mode-tab {
    min-width: 0;
    min-height: 34px;
    height: 34px;
    padding: 4px 8px;
    font-size: 10px;
    white-space: normal;
    line-height: 1.15;
  }
  .decant-mode-tab svg { width: 15px; height: 15px; flex: 0 0 auto; }
  .decant-invoice-mode-help { min-width: 0; margin: 0; font-size: 9px; line-height: 1.25; }
  .decant-invoices-hub-body { min-width: 0; min-height: 0; overflow: hidden; }

  .decant-invoices-hub .decant-invoice-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    gap: 7px;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .decant-invoices-hub .decant-invoice-editor,
  .decant-invoices-hub .decant-invoice-history {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }

  .decant-invoices-hub .decant-invoice-editor {
    grid-template-rows: auto auto auto minmax(0, 1fr) auto auto;
    gap: 4px;
    padding: 6px;
    overflow: visible;
    position: relative;
    z-index: 2;
  }

  .decant-invoices-hub .decant-invoice-history {
    grid-template-rows: auto minmax(0, 1fr);
    gap: 4px;
    padding: 6px;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  .decant-invoices-hub .decant-invoice-heading h2 { font-size: 12px; }
  .decant-invoices-hub .decant-invoice-heading h3 { font-size: 11px; }
  .decant-invoices-hub .decant-invoice-heading p { font-size: 8.5px; line-height: 1.2; }
  .decant-invoices-hub .decant-invoice-heading > strong { font-size: 14px; }

  .decant-invoices-hub .decant-invoice-meta { gap: 4px; }
  .decant-invoices-hub .decant-invoice-meta label,
  .decant-invoices-hub .decant-add-row label { gap: 1px; font-size: 8.5px; }
  .decant-invoices-hub .decant-invoice-meta select,
  .decant-invoices-hub .decant-add-row select,
  .decant-invoices-hub .perfume-product-search input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 28px;
    min-height: 28px;
    padding-block: 2px;
    border-radius: 4px;
    font-size: 9px;
  }
  .decant-invoices-hub .decant-add-row { gap: 4px; }
  .decant-invoices-hub .decant-add-row button,
  .decant-invoices-hub .decant-invoice-actions button {
    height: 28px;
    min-height: 28px;
    padding: 2px 8px;
    font-size: 9px;
  }

  .decant-invoices-hub .decant-lines-scroll,
  .decant-invoices-hub .decant-invoice-history-scroll {
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .decant-invoices-hub .decant-lines-table,
  .decant-invoices-hub .decant-invoice-history-table {
    width: 100%;
    min-width: 0 !important;
    table-layout: fixed;
  }

  .decant-invoices-hub .decant-lines-table th,
  .decant-invoices-hub .decant-lines-table td,
  .decant-invoices-hub .decant-invoice-history-table th,
  .decant-invoices-hub .decant-invoice-history-table td {
    box-sizing: border-box;
    height: 26px;
    padding: 2px 3px;
    font-size: 8.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .decant-invoices-hub .decant-lines-table input,
  .decant-invoices-hub .decant-lines-table select,
  .decant-invoices-hub .decant-lines-table button,
  .decant-invoices-hub .decant-invoice-history-table button {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 23px;
    min-height: 23px;
    padding: 1px 3px;
    border-radius: 3px;
    font-size: 8px;
  }

  .decant-invoices-hub .decant-invoice-history-table .action-cell {
    display: flex;
    align-items: center;
    gap: 2px;
    white-space: normal;
  }
  .decant-invoices-hub .decant-invoice-history-table .action-cell button { flex: 1 1 0; }

  /* Management follows the same two-column visual grammar as the invoices:
     operations on one side and the growing batch register on the other. */
  .decant-invoices-hub-body.management { overflow: hidden; }
  .decant-invoices-hub-body.management .perfume-divisions-page,
  .perfume-divisions-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, .9fr) minmax(0, 1.1fr);
    grid-template-areas:
      "split batches"
      "bottles batches";
    gap: 7px;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    padding: 0;
    overflow: hidden;
  }

  .perfume-split-card { grid-area: split; }
  .perfume-bottles-card { grid-area: bottles; }
  .perfume-batches-card { grid-area: batches; }

  .decant-invoices-hub-body.management .perfume-divisions-card {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 0;
    margin: 0;
    padding: 6px 7px;
    gap: 4px;
    overflow: hidden;
  }

  .decant-invoices-hub-body.management .perfume-split-card {
    overflow: visible;
    position: relative;
    z-index: 5;
  }

  .decant-invoices-hub-body.management .perfume-divisions-heading { gap: 7px; }
  .decant-invoices-hub-body.management .perfume-divisions-heading h2 { font-size: 12px; }
  .decant-invoices-hub-body.management .perfume-divisions-heading p { margin-top: 1px; font-size: 8.5px; line-height: 1.2; }
  .decant-invoices-hub-body.management .perfume-split-action {
    min-width: 155px;
    width: auto;
    min-height: 30px;
    height: 30px;
    padding-inline: 8px;
    font-size: 9px;
    box-shadow: 0 2px 7px rgba(11,109,103,.14);
  }

  .decant-invoices-hub-body.management .perfume-divisions-form-v2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
  }
  .decant-invoices-hub-body.management .perfume-divisions-form label,
  .decant-invoices-hub-body.management .perfume-bottle-create label { gap: 1px; font-size: 8.5px; }
  .decant-invoices-hub-body.management .perfume-divisions-form :is(input,select),
  .decant-invoices-hub-body.management .perfume-bottle-create :is(input,button),
  .decant-invoices-hub-body.management .perfume-product-search input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: 28px;
    min-height: 28px;
    padding-block: 2px;
    border-radius: 4px;
    font-size: 9px;
  }

  .decant-invoices-hub-body.management .perfume-cost-preview-v2 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
  }
  .decant-invoices-hub-body.management .perfume-cost-preview > div {
    min-width: 0;
    min-height: 43px;
    padding: 4px 6px;
  }
  .decant-invoices-hub-body.management .perfume-cost-preview span,
  .decant-invoices-hub-body.management .perfume-cost-preview small { font-size: 8px; }
  .decant-invoices-hub-body.management .perfume-cost-preview strong { font-size: 12px; }

  .decant-invoices-hub-body.management .perfume-bottle-create {
    grid-template-columns: minmax(0, 1.5fr) minmax(70px, .65fr) minmax(90px, .8fr) auto;
    gap: 4px;
  }

  .decant-invoices-hub-body.management .perfume-bottles-card,
  .decant-invoices-hub-body.management .perfume-batches-card {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .decant-invoices-hub-body.management .perfume-batches-card { grid-template-rows: auto minmax(0, 1fr); }

  .decant-invoices-hub-body.management .perfume-bottles-table-wrap,
  .decant-invoices-hub-body.management .perfume-batches-table-wrap {
    width: 100%;
    min-width: 0;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .decant-invoices-hub-body.management .perfume-bottles-table,
  .decant-invoices-hub-body.management .perfume-batches-table {
    width: 100%;
    min-width: 0 !important;
    table-layout: fixed;
  }
  .decant-invoices-hub-body.management :is(.perfume-bottles-table,.perfume-batches-table) th,
  .decant-invoices-hub-body.management :is(.perfume-bottles-table,.perfume-batches-table) td {
    box-sizing: border-box;
    height: 25px;
    padding: 2px 3px;
    font-size: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .decant-invoices-hub-body.management .perfume-recombine-control {
    min-width: 0;
    gap: 2px;
  }
  .decant-invoices-hub-body.management .perfume-recombine-control :is(input,button) {
    min-width: 0;
    height: 24px;
    min-height: 24px;
    padding: 1px 3px;
    font-size: 8px;
  }
}

/* Search banner shared by decant sale and perfume conversion. */
.perfume-product-picker { position: relative; min-width: 0; }
.perfume-product-search { position: relative; display: flex; align-items: center; min-width: 0; }
.perfume-product-search > svg { position: absolute; inset-inline-start: 9px; width: 15px; height: 15px; color: var(--muted,#667085); pointer-events: none; z-index: 1; }
.perfume-product-search input { width: 100%; min-width: 0; padding-inline-start: 31px !important; padding-inline-end: 30px !important; }
.perfume-product-search-clear { position: absolute; inset-inline-end: 4px; width: 25px; height: 25px; min-height: 25px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted,#667085); }
.perfume-product-search-clear svg { width: 14px; height: 14px; }
.perfume-product-results { position: absolute; inset-inline: 0; top: calc(100% + 4px); z-index: 80; max-height: 230px; overflow: auto; border: 1px solid var(--border,#d0d5dd); border-radius: 7px; background: #fff; box-shadow: 0 10px 24px rgba(15,23,42,.14); }
.perfume-product-results > button { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 38px; padding: 6px 9px; border: 0; border-bottom: 1px solid #eef1f3; border-radius: 0; background: #fff; color: inherit; text-align: start; }
.perfume-product-results > button:last-child { border-bottom: 0; }
.perfume-product-results > button:hover,
.perfume-product-results > button.selected { background: #eef7ff; }
.perfume-product-results > button:disabled { opacity: .5; }
.perfume-product-results span { display: grid; gap: 1px; min-width: 0; }
.perfume-product-results strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.perfume-product-results small,
.perfume-product-results bdi { color: var(--muted,#667085); font-size: 8.5px; }
.perfume-product-empty { padding: 10px; text-align: center; color: var(--muted,#667085); }
.decant-add-row-search { position: relative; z-index: 20; }

.perfume-bottle-adjust { display: grid; grid-template-columns: minmax(60px,.65fr) minmax(90px,1fr) auto auto; align-items: center; gap: 3px; min-width: 0; }
.perfume-bottle-adjust input,
.perfume-bottle-adjust button { min-width: 0; min-height: 24px; height: 24px; padding: 1px 4px; border-radius: 4px; font-size: 8px; }

@media (min-width: 1051px) and (max-width: 1280px) {
  .sidebar { gap: 12px; padding-inline: 14px; }
  .sidebar nav { gap: 2px; }
  .nav { min-height: 52px; padding-inline: 8px; gap: 6px; font-size: 11px; }
  .nav svg { width: 18px; height: 18px; }
  .nav span { font-size: 11px; }
  .brand strong { font-size: 24px; }
  .brand-logo { width: 40px; height: 40px; flex-basis: 40px; }
  .decant-invoice-mode-tabs { min-width: 455px; width: 62%; }
  .decant-invoice-mode-help { font-size: 8.5px; }
}

@media (max-width: 1050px) {
  .decant-invoices-hub { height: auto; min-height: 100%; overflow: visible; }
  .decant-invoice-modebar { align-items: stretch; flex-direction: column; height: auto; }
  .decant-invoice-mode-tabs { width: 100%; min-width: 0; grid-template-columns: 1fr; }
  .decant-invoices-hub-body { overflow: visible; }
  .decant-invoices-hub .decant-invoice-page { height: auto; min-height: 100%; grid-template-columns: 1fr; grid-template-rows: auto auto; overflow: visible; }
  .decant-invoices-hub .decant-invoice-editor,
  .decant-invoices-hub .decant-invoice-history { height: auto; overflow: visible; }
  .decant-lines-scroll,
  .decant-invoice-history-scroll { max-height: 55vh; }
  .perfume-divisions-page { height: auto; min-height: 100%; grid-template-columns: 1fr; grid-template-areas: "split" "bottles" "batches"; grid-template-rows: auto auto auto; overflow: visible; padding-bottom: max(28px, env(safe-area-inset-bottom)); }
  .perfume-bottle-adjust { grid-template-columns: 1fr 1fr; min-width: 0; }
}
'''
css_path.write_text(css, encoding="utf-8")

print("direct UI patch applied")
