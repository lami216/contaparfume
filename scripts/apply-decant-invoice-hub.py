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


app = "app/conta-app.tsx"
replace_once(
    app,
    'import { DecantBottlePurchaseInvoice, DecantSaleInvoice } from "./perfume-invoices";',
    'import DecantInvoicesPage from "./decant-invoices-page";',
)
replace_once(
    app,
    '  | "decantSales"\n  | "decantPurchases"',
    '  | "decantInvoices"',
)
replace_once(
    app,
    '  { id: "decantSales", label: "فاتورة التقسيمات", icon: ShoppingCart },\n  { id: "decantPurchases", label: "فاتورة شراء زجاج التقسيمات", icon: PackagePlus },',
    '  { id: "decantInvoices", label: "فواتير التقسيمات", icon: ShoppingCart },',
)
replace_once(
    app,
    'const viewCapability:Record<View,string>={pos:"pos.view",purchases:"purchases.view",decantSales:"perfume.divisions.view",decantPurchases:"perfume.divisions.view",expenses:',
    'const viewCapability:Record<View,string>={pos:"pos.view",purchases:"purchases.view",decantInvoices:"perfume.divisions.view",expenses:',
)
replace_once(
    app,
    '["pos","decantSales","decantPurchases","purchases","records","products","perfumeDivisions","customers","suppliers","warehouses","expenses","banks","reports","settings"]',
    '["pos","decantInvoices","purchases","records","products","perfumeDivisions","customers","suppliers","warehouses","expenses","banks","reports","settings"]',
)
replace_once(
    app,
    '              {view === "decantSales" && <DecantSaleInvoice data={data} run={run} openDoc={openDoc} />}{" "}\n              {view === "decantPurchases" && <DecantBottlePurchaseInvoice data={data} run={run} openDoc={openDoc} />}{" "}',
    '              {view === "decantInvoices" && <DecantInvoicesPage data={data} run={run} openDoc={openDoc} />}{" "}',
)
app_text = read(app)
if '"decantSales"' in app_text or '"decantPurchases"' in app_text:
    raise SystemExit("Old decant invoice views remain in conta-app.tsx")

messages = "app/i18n/messages.ts"
text = read(messages)
if '"فواتير التقسيمات": "فواتير التقسيمات",' not in text:
    anchor = '  "فاتورة بيع": "فاتورة بيع",'
    if anchor not in text:
        raise SystemExit("Arabic invoice translation anchor not found")
    text = text.replace(anchor, anchor + '\n  "فواتير التقسيمات": "فواتير التقسيمات",', 1)
if '"فواتير التقسيمات": "Factures de décants",' not in text:
    anchor = '  "فاتورة بيع": "Facture de vente",'
    if anchor not in text:
        raise SystemExit("French invoice translation anchor not found")
    text = text.replace(anchor, anchor + '\n  "فواتير التقسيمات": "Factures de décants",', 1)
write(messages, text)

css = "app/globals.css"
css_text = read(css)
marker = "/* unified-decant-invoice-hub */"
if marker not in css_text:
    css_text += '''\n\n/* unified-decant-invoice-hub */
.section-decantInvoices { --section-color: var(--color-invoices, #0b6d67); --section-soft: #eaf7f5; }
.decant-invoices-hub { display:grid; grid-template-rows:auto minmax(0,1fr); gap:7px; width:100%; height:100%; min-height:0; overflow:hidden; }
.decant-invoice-modebar { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:54px; padding:7px 9px; border:1px solid var(--border,#d0d5dd); border-radius:9px; background:var(--panel,#fff); box-shadow:0 3px 12px rgba(15,23,42,.04); }
.decant-invoice-mode-tabs { display:grid; grid-template-columns:repeat(2,minmax(180px,1fr)); gap:5px; width:min(560px,58%); min-width:410px; padding:3px; border:1px solid #cfe3df; border-radius:7px; background:#f4faf9; }
.decant-mode-tab { display:flex; align-items:center; justify-content:center; gap:7px; min-height:36px; padding:5px 10px; border:0; border-radius:5px; color:#52605e; background:transparent; font-weight:800; font-size:10px; cursor:pointer; }
.decant-mode-tab svg { width:16px; height:16px; }
.decant-mode-tab.active { color:#fff; background:var(--section-color,#0b6d67); box-shadow:0 2px 7px rgba(11,109,103,.18); }
.decant-invoice-mode-help { flex:1; margin:0; color:var(--muted,#667085); font-size:10px; line-height:1.45; text-align:start; }
.decant-invoices-hub-body { min-width:0; min-height:0; overflow:hidden; }
.decant-invoices-hub .decant-invoice-page { grid-template-rows:minmax(0,1fr) minmax(118px,.30fr); gap:6px; }
.decant-invoices-hub .decant-invoice-editor { gap:5px; padding:7px; }
.decant-invoices-hub .decant-invoice-history { padding:6px 7px; }
.decant-invoices-hub .decant-invoice-heading h2 { font-size:13px; }
.decant-invoices-hub .decant-invoice-heading h3 { font-size:12px; }
.decant-invoices-hub .decant-invoice-heading > strong { font-size:14px; }
.decant-invoices-hub .decant-lines-table th,
.decant-invoices-hub .decant-lines-table td,
.decant-invoices-hub .decant-invoice-history-table th,
.decant-invoices-hub .decant-invoice-history-table td { height:27px; }
@media(max-width:1050px){
  .decant-invoices-hub { height:auto; min-height:100%; overflow:visible; }
  .decant-invoice-modebar { align-items:stretch; flex-direction:column; }
  .decant-invoice-mode-tabs { width:100%; min-width:0; }
  .decant-invoices-hub-body { overflow:visible; }
}
@media(max-width:620px){
  .decant-invoice-mode-tabs { grid-template-columns:1fr; }
}
'''
    write(css, css_text)

test_path = "tests/decant-v2.test.mjs"
tests = read(test_path)
tests = tests.replace(
    '  assert.match(app, /id: "decantSales", label: "فاتورة التقسيمات"/);\n  assert.match(app, /id: "decantPurchases", label: "فاتورة شراء زجاج التقسيمات"/);',
    '  assert.match(app, /id: "decantInvoices", label: "فواتير التقسيمات"/);\n  assert.doesNotMatch(app, /id: "decantPurchases"/);',
)
if 'id: "decantSales"' in tests:
    raise SystemExit("Old decantSales navigation assertion remains")
write(test_path, tests)

hub_test = Path("tests/decant-invoice-hub.test.mjs")
if not hub_test.exists():
    hub_test.write_text('''import assert from "node:assert/strict";\nimport test from "node:test";\nimport { readFile } from "node:fs/promises";\n\nconst source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");\n\ntest("decant sale and bottle purchase live in one invoice workspace", async () => {\n  const [app, hub, css] = await Promise.all([source("app/conta-app.tsx"), source("app/decant-invoices-page.tsx"), source("app/globals.css")]);\n  assert.match(app, /id: "decantInvoices", label: "فواتير التقسيمات"/);\n  assert.match(app, /view === "decantInvoices" && <DecantInvoicesPage/);\n  assert.doesNotMatch(app, /view === "decantPurchases"/);\n  assert.match(hub, /DecantSaleInvoice/);\n  assert.match(hub, /DecantBottlePurchaseInvoice/);\n  assert.match(hub, /role="tablist"/);\n  assert.match(hub, /mode === "sale"/);\n  assert.match(hub, /mode === "purchase"/);\n  assert.match(css, /\.decant-invoices-hub\s*\{/);\n  assert.match(css, /\.decant-invoice-mode-tabs\s*\{/);\n});\n''', encoding="utf-8")

print("Unified decant invoice hub patch applied")
