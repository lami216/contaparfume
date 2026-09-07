from pathlib import Path
import re

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text(encoding='utf-8')

def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')

def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f'MISSING in {path}: {old[:160]!r}')
    text = text.replace(old, new, 1)
    write(path, text)

def regex_once(path, pattern, replacement, flags=0):
    text = read(path)
    new, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'REGEX count={count} in {path}: {pattern[:160]!r}')
    write(path, new)

# ---------- domain ----------
replace_once('app/domain.ts',
'''export interface Product {''',
'''export interface ProductCategory {\n  id: string;\n  name: string;\n}\n\nexport interface Product {''')
replace_once('app/domain.ts',
'''  note?: string | null;\n  perfumeForm?: PerfumeForm | null;''',
'''  note?: string | null;\n  categoryId?: string | null;\n  perfumeForm?: PerfumeForm | null;''')
replace_once('app/domain.ts',
'''  products: Product[];\n  documents: DocumentRecord[];''',
'''  products: Product[];\n  categories: ProductCategory[];\n  documents: DocumentRecord[];''')

# ---------- bootstrap ----------
replace_once('app/api/bootstrap/route.ts',
'''const [parties, warehouses, products, documents, movements, financialMovements, partyMetricDocuments, partyMetricMovements, paymentAccounts, accountTransfers, productCounter, nextSale, nextPurchase, nextExpense, nextDecantSale, nextDecantPurchase, branding] = await Promise.all([''',
'''const [parties, warehouses, products, productCategories, documents, movements, financialMovements, partyMetricDocuments, partyMetricMovements, paymentAccounts, accountTransfers, productCounter, nextSale, nextPurchase, nextExpense, nextDecantSale, nextDecantPurchase, branding] = await Promise.all([''')
replace_once('app/api/bootstrap/route.ts',
'''db.collection("products").find().sort({ name: 1 }).toArray(), db.collection("documents").find().sort({ occurredAt: -1 }).limit(500).toArray(),''',
'''db.collection("products").find().sort({ name: 1 }).toArray(), db.collection("productCategories").find().sort({ name: 1 }).toArray(), db.collection("documents").find().sort({ occurredAt: -1 }).limit(500).toArray(),''')
replace_once('app/api/bootstrap/route.ts',
'''const cleanProducts = clean(products).map(product => ({ ...product, wholesalePrice: (product as Record<string, unknown>).wholesalePrice ?? null, expiryDate: (product as Record<string, unknown>).expiryDate ?? null, note: (product as Record<string, unknown>).note ?? null }));''',
'''const cleanProducts = clean(products).map(product => ({ ...product, wholesalePrice: (product as Record<string, unknown>).wholesalePrice ?? null, expiryDate: (product as Record<string, unknown>).expiryDate ?? null, note: (product as Record<string, unknown>).note ?? null, categoryId: (product as Record<string, unknown>).categoryId ?? null }));\n    const cleanCategories = clean(productCategories).map(category => ({ id: String(category.id), name: String(category.name ?? "") })).filter(category => category.name);''')
replace_once('app/api/bootstrap/route.ts',
'''map(({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,stocks,isArchived})=>({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,stocks,isArchived,pieceCost:null,lastPurchaseCost:null}))''',
'''map(({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,categoryId,stocks,isArchived})=>({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,categoryId,stocks,isArchived,pieceCost:null,lastPurchaseCost:null}))''')
replace_once('app/api/bootstrap/route.ts',
'''products:exposedProducts, documents:allowedDocuments,''',
'''products:exposedProducts, categories:cleanCategories, documents:allowedDocuments,''')

# ---------- command API ----------
replace_once('app/api/command/route.ts',
'''"product.create":"products.create","product.update":"products.edit"''',
'''"product.create":"products.create","product.update":"products.edit","product-category.create":"products.create"''')
replace_once('app/api/command/route.ts',
'''  if (type === "product.create" || type === "product.update") {\n    const name = text(body.name), barcode = text(body.barcode);''',
'''  if (type === "product-category.create") {\n    const name = text(body.name);\n    if (!name) throw new CommandError("اسم الفئة مطلوب");\n    if (name.length > 80) throw new CommandError("اسم الفئة طويل جدًا");\n    const existing = await db.collection("productCategories").find({}, { session, projection: { id: 1, name: 1 } }).toArray();\n    if (existing.some(category => String(category.name ?? "").trim().toLowerCase() === name.toLowerCase())) throw new CommandError("هذه الفئة موجودة بالفعل", 409);\n    const category = { id: id("category"), name, createdAt: new Date() };\n    await db.collection("productCategories").insertOne(category, { session });\n    return category.id;\n  }\n  if (type === "product.create" || type === "product.update") {\n    const name = text(body.name), barcode = text(body.barcode);''')
replace_once('app/api/command/route.ts',
'''    const pieceCost = optionalNumber(body.pieceCost, "سعر الشراء"), values = { name, barcode, expiryDate: optionalDate(body.expiryDate), note: note || null, pieceCost, piecePrice: optionalNumber(body.piecePrice, "سعر البيع"), wholesalePrice: optionalNumber(body.wholesalePrice, "سعر الجملة") };''',
'''    const categoryId = text(body.categoryId);\n    if (categoryId && !await db.collection("productCategories").findOne({ id: categoryId }, { session })) throw new CommandError("الفئة غير موجودة", 404);\n    const pieceCost = optionalNumber(body.pieceCost, "سعر الشراء"), values = { name, barcode, expiryDate: optionalDate(body.expiryDate), note: note || null, categoryId: categoryId || null, pieceCost, piecePrice: optionalNumber(body.piecePrice, "سعر البيع"), wholesalePrice: optionalNumber(body.wholesalePrice, "سعر الجملة") };''')
replace_once('app/api/command/route.ts',
'''{$set:{name,barcode,expiryDate:values.expiryDate,note:values.note,piecePrice:values.piecePrice,wholesalePrice:values.wholesalePrice}}''',
'''{$set:{name,barcode,expiryDate:values.expiryDate,note:values.note,categoryId:values.categoryId,piecePrice:values.piecePrice,wholesalePrice:values.wholesalePrice}}''')
# Generated decants inherit the source perfume category.
replace_once('app/api/command/route.ts',
'''wholesalePrice:null,expiryDate:null,note:null,perfumeForm:"decant"''',
'''wholesalePrice:null,expiryDate:null,note:null,categoryId:source.categoryId??null,perfumeForm:"decant"''')

# ---------- report filters / report backend ----------
replace_once('app/report-types.ts',
'''  productId?: string;\n  warehouseId?: string;''',
'''  productId?: string;\n  categoryId?: string;\n  warehouseId?: string;''')
replace_once('lib/reports.ts',
'''partyId: text(url.searchParams.get("partyId")) || undefined, productId: text(url.searchParams.get("productId")) || undefined, paymentAccountId:''',
'''partyId: text(url.searchParams.get("partyId")) || undefined, productId: text(url.searchParams.get("productId")) || undefined, categoryId: text(url.searchParams.get("categoryId")) || undefined, paymentAccountId:''')
replace_once('lib/reports.ts',
'''const lineMatches = (line: Document, f: ReportFilters) => !f.productId || String(line.productId) === f.productId;''',
'''type ProductScope = Set<string> | null;\nconst lineMatches = (line: Document, f: ReportFilters, categoryScope: ProductScope = null) => (!f.productId || String(line.productId) === f.productId) && (!f.categoryId || categoryScope?.has(String(line.productId)) === true);\nconst productConstraint = (f: ReportFilters, categoryScope: ProductScope): unknown => f.productId || (f.categoryId ? { $in: categoryScope?.size ? [...categoryScope] : ["__no_category_products__"] } : undefined);''')
replace_once('lib/reports.ts',
'''async function saleFacts(db: Db, documents: Document[], f: ReportFilters) {''',
'''async function saleFacts(db: Db, documents: Document[], f: ReportFilters, categoryScope: ProductScope = null) {''')
replace_once('lib/reports.ts',
'''    if (!lineMatches(line, f)) continue;''',
'''    if (!lineMatches(line, f, categoryScope)) continue;''')
replace_once('lib/reports.ts',
'''async function directDocuments(db: Db, f: ReportFilters, kind: string | string[]) {\n  const query: Document = { kind: Array.isArray(kind) ? { $in: kind } : kind, status: "posted", ...matchDate(f) };\n  if (f.paymentAccountId) query.paymentMethod = f.paymentAccountId;\n  if (f.productId) query["lines.productId"] = f.productId;''',
'''async function directDocuments(db: Db, f: ReportFilters, kind: string | string[], categoryScope: ProductScope = null) {\n  const query: Document = { kind: Array.isArray(kind) ? { $in: kind } : kind, status: "posted", ...matchDate(f) };\n  if (f.paymentAccountId) query.paymentMethod = f.paymentAccountId;\n  const scopedProduct = productConstraint(f, categoryScope);\n  if (scopedProduct) query["lines.productId"] = scopedProduct;''')
replace_once('lib/reports.ts',
'''export async function buildReport(db: Db, f: ReportFilters): Promise<ReportResponse> {\n  const expiryLoss''',
'''export async function buildReport(db: Db, f: ReportFilters): Promise<ReportResponse> {\n  const categoryScope: ProductScope = f.categoryId ? new Set((await db.collection("products").find({ categoryId: f.categoryId }).project({ id: 1 }).toArray()).map(product => String(product.id))) : null;\n  const scopedProduct = productConstraint(f, categoryScope);\n  const hasProductFilter = Boolean(f.productId || f.categoryId);\n  const expiryLoss''')
replace_once('lib/reports.ts',
'''const sales = await directDocuments(db, f, ["sale", "decant-sale"]);''',
'''const sales = await directDocuments(db, f, ["sale", "decant-sale"], categoryScope);''')
replace_once('lib/reports.ts',
'''const returnQuery = { kind: "return", status: "posted", ...matchDate(f), ...(f.productId ? { "lines.productId": f.productId } : {}) };''',
'''const returnQuery = { kind: "return", status: "posted", ...matchDate(f), ...(scopedProduct ? { "lines.productId": scopedProduct } : {}) };''')
replace_once('lib/reports.ts',
'''const summaryFacts = await saleFacts(db, [...sales.all, ...legacySaleAdjustments], f)''',
'''const summaryFacts = await saleFacts(db, [...sales.all, ...legacySaleAdjustments], f, categoryScope)''')
replace_once('lib/reports.ts',
'''const rows = f.productId ? pageFacts : sales.rows.map''',
'''const rows = hasProductFilter ? pageFacts : sales.rows.map''')
replace_once('lib/reports.ts',
'''f.productId ? (d.lines as Document[]).filter(l => lineMatches(l, f)).reduce''',
'''hasProductFilter ? (d.lines as Document[]).filter(l => lineMatches(l, f, categoryScope)).reduce''')
replace_once('lib/reports.ts',
'''found = await directDocuments(db, f, kind);''',
'''found = await directDocuments(db, f, kind, categoryScope);''')
replace_once('lib/reports.ts',
'''const rows = found.rows.map(document => { const selected = ((document.lines ?? []) as Document[]).filter(line => lineMatches(line, f));''',
'''const rows = found.rows.map(document => { const selected = ((document.lines ?? []) as Document[]).filter(line => lineMatches(line, f, categoryScope));''')
replace_once('lib/reports.ts',
'''const value = (d: Document) => f.productId ? (d.lines as Document[]).filter(l=>lineMatches(l,f)).reduce''',
'''const value = (d: Document) => hasProductFilter ? (d.lines as Document[]).filter(l=>lineMatches(l,f,categoryScope)).reduce''')
replace_once('lib/reports.ts',
'''(d.lines as Document[]).filter(l=>lineMatches(l,f)).reduce((x,l)=>x+n(l.quantity),0)''',
'''(d.lines as Document[]).filter(l=>lineMatches(l,f,categoryScope)).reduce((x,l)=>x+n(l.quantity),0)''')
replace_once('lib/reports.ts',
'''if (f.productId && f.type === "stock") query.productId=f.productId;''',
'''if (f.type === "stock" && scopedProduct) query.productId=scopedProduct;''')
replace_once('lib/reports.ts',
'''find({kind:{$in:["sale","decant-sale","return"]},status:"posted",...matchDate(f),...(f.productId?{"lines.productId":f.productId}:{})}).toArray(),facts=await saleFacts(db,documents,f);''',
'''find({kind:{$in:["sale","decant-sale","return"]},status:"posted",...matchDate(f),...(scopedProduct?{"lines.productId":scopedProduct}:{})}).toArray(),facts=await saleFacts(db,documents,f,categoryScope);''')
replace_once('lib/reports.ts',
'''find({kind:{$in:["purchase","decant-purchase"]},status:"posted",...matchDate(f),...(f.productId?{"lines.productId":f.productId}:{})}).project({lines:1}).toArray();''',
'''find({kind:{$in:["purchase","decant-purchase"]},status:"posted",...matchDate(f),...(scopedProduct?{"lines.productId":scopedProduct}:{})}).project({lines:1}).toArray();''')
replace_once('lib/reports.ts',
'''const productQuery:Document={...(f.productId?{id:f.productId}:{})};''',
'''const productQuery:Document={...(f.productId?{id:f.productId}:f.categoryId?{categoryId:f.categoryId}:{})};''')

# ---------- category manager component ----------
write('app/product-category-dialog.tsx', '''"use client";\nimport { useState } from "react";\nimport { Plus, X } from "lucide-react";\nimport type { ProductCategory } from "./domain";\nimport { tr } from "./i18n/messages";\n\ntype RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;\n\nexport default function ProductCategoryDialog({ categories, run, close }: { categories: ProductCategory[]; run: RunCommand; close: () => void }) {\n  const [name, setName] = useState("");\n  const [busy, setBusy] = useState(false);\n  const submit = async (event: React.FormEvent) => {\n    event.preventDefault();\n    if (!name.trim() || busy) return;\n    setBusy(true);\n    try { await run({ type: "product-category.create", name: name.trim() }, tr("تمت إضافة الفئة")); setName(""); } finally { setBusy(false); }\n  };\n  return <div className="modal-card product-category-modal">\n    <div className="product-form-head"><div><small>{tr("الفئات")}</small><h2>{tr("إضافة فئة")}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>\n    <form className="product-category-create" onSubmit={submit}><label>{tr("اسم الفئة")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}><Plus />{busy ? tr("جاري الحفظ…") : tr("إضافة فئة")}</button></form>\n    <div className="product-category-list"><strong>{tr("الفئات الحالية")}</strong>{categories.length ? <div>{categories.map(category => <span key={category.id}>{category.name}</span>)}</div> : <p>{tr("لا توجد فئات حتى الآن")}</p>}</div>\n    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>\n  </div>;\n}\n''')

# ---------- products + reports UI ----------
replace_once('app/conta-app.tsx',
'''import DecantInvoicesPage from "./decant-invoices-page";''',
'''import DecantInvoicesPage from "./decant-invoices-page";\nimport ProductCategoryDialog from "./product-category-dialog";''')
replace_once('app/conta-app.tsx',
'''  products: [],\n  documents: [],''',
'''  products: [],\n  categories: [],\n  documents: [],''')
# Add category manager state in Products.
regex_once('app/conta-app.tsx',
 r'(function Products\(\{ data, run \}: \{ data: BootstrapData; run: RunCommand \} \) \{[\s\S]*?const \[showArchived, setShowArchived\] = useState\(false\);)',
 r'\1\n  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);')
# Add toolbar button immediately before Add Product button.
regex_once('app/conta-app.tsx',
 r'(<button className="primary"[^>]*onClick=\{\(\) => openForm\(null\)\}[^>]*><Plus\s*/>\s*\{tr\("إضافة منتج"\)\}</button>)',
 r'<button className="soft" type="button" onClick={() => setCategoryDialogOpen(true)}><Plus /> {tr("إضافة فئة")}</button>\1')
# Pass categories into ProductForm and render manager modal.
replace_once('app/conta-app.tsx',
'''<ProductForm run={run} product={editing} warehouses={activeWarehouses(data.warehouses)} close={() => setFormOpen(false)} />''',
'''<ProductForm run={run} product={editing} warehouses={activeWarehouses(data.warehouses)} categories={data.categories} close={() => setFormOpen(false)} />''')
replace_once('app/conta-app.tsx',
'''    {formOpen && <div className="modal-overlay" role="dialog"''',
'''    {categoryDialogOpen && <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={tr("إضافة فئة")}><ProductCategoryDialog categories={data.categories} run={run} close={() => setCategoryDialogOpen(false)} /></div>}\n    {formOpen && <div className="modal-overlay" role="dialog"''')
# ProductForm signature/state/payload/field.
replace_once('app/conta-app.tsx',
'''function ProductForm({ run, close, product, warehouses }: { run: RunCommand; close: () => void; product: Product | null; warehouses: BootstrapData["warehouses"] }) {''',
'''function ProductForm({ run, close, product, warehouses, categories }: { run: RunCommand; close: () => void; product: Product | null; warehouses: BootstrapData["warehouses"]; categories: BootstrapData["categories"] }) {''')
replace_once('app/conta-app.tsx',
'''[barcode, setBarcode] = useState(product?.barcode ?? ""), [expiryDate, setExpiryDate] = useState(product?.expiryDate ?? ""), [note, setNote] = useState(product?.note ?? "");''',
'''[barcode, setBarcode] = useState(product?.barcode ?? ""), [categoryId, setCategoryId] = useState(product?.categoryId ?? ""), [expiryDate, setExpiryDate] = useState(product?.expiryDate ?? ""), [note, setNote] = useState(product?.note ?? "");''')
replace_once('app/conta-app.tsx',
'''pieceCost: cost, piecePrice: price, wholesalePrice, openingStock,''',
'''pieceCost: cost, piecePrice: price, wholesalePrice, categoryId, openingStock,''')
replace_once('app/conta-app.tsx',
'''        <label className="barcode-field">{tr("الباركود")}''',
'''        <label>{tr("الفئة")}<SearchableSelect value={categoryId} onChange={setCategoryId} options={categories.map(category => ({ value: category.id, label: category.name }))} placeholder={tr("بدون فئة")} searchPlaceholder={tr("ابحث عن فئة")} allowEmpty /></label>\n        <label className="barcode-field">{tr("الباركود")}''')

# Reports category state, request, reset, refresh and options.
replace_once('app/conta-app.tsx',
'''[partyId,setPartyId]=useState(""),[productId,setProductId]=useState(""),[accountId,setAccountId]''',
'''[partyId,setPartyId]=useState(""),[productId,setProductId]=useState(""),[categoryId,setCategoryId]=useState(""),[accountId,setAccountId]''')
replace_once('app/conta-app.tsx',
'''if(["sales","purchases","product-sales","profit","stock"].includes(type))add("productId",productId);''',
'''if(["sales","purchases","product-sales","profit","stock"].includes(type)){add("categoryId",categoryId);add("productId",productId);}''')
replace_once('app/conta-app.tsx',
'''setCommittedPeriod(null);setProductId("");setAccountId("");''',
'''setCommittedPeriod(null);setCategoryId("");setProductId("");setAccountId("");''')
replace_once('app/conta-app.tsx',
'''},[productId,accountId,groupBy,movementType,direction,debtSide,search,partyId]);''',
'''},[categoryId,productId,accountId,groupBy,movementType,direction,debtSide,search,partyId]);''')
replace_once('app/conta-app.tsx',
'''const productOptions=data.products.map(p=>({value:p.id,label:`${p.name}${p.isArchived ? ` ${tr("(مؤرشف)")}` : ""}`,search:`${p.name} ${p.sku??""} ${p.barcode??""}`})),partyOptions=''',
'''const productReport=["sales","purchases","product-sales","profit","stock"].includes(type),categoryOptions=data.categories.map(category=>({value:category.id,label:category.name,search:category.name})),productOptions=data.products.filter(p=>!categoryId||p.categoryId===categoryId).map(p=>({value:p.id,label:`${p.name}${p.isArchived ? ` ${tr("(مؤرشف)")}` : ""}`,search:`${p.name} ${p.sku??""} ${p.barcode??""}`})),partyOptions=''' )
replace_once('app/conta-app.tsx',
'''table=reportTableModel(reportColumns(type,productId,groupBy),result)''',
'''table=reportTableModel(reportColumns(type,productId||categoryId,groupBy),result)''')
replace_once('app/conta-app.tsx',
'''productFiltered:Boolean(productId)''',
'''productFiltered:Boolean(productId||categoryId)''')
# Category selector immediately after the date controls / عرض الكل, before Print.
replace_once('app/conta-app.tsx',
'''{!showDates&&<button className="primary" onClick={applyDraftPeriod}>{tr("عرض")}</button>}<button className="report-print-button"''',
'''{!showDates&&<button className="primary" onClick={applyDraftPeriod}>{tr("عرض")}</button>}{productReport&&<div className="report-category-filter"><SearchableSelect value={categoryId} onChange={value=>{setCategoryId(value);if(productId&&!data.products.some(product=>product.id===productId&&(!value||product.categoryId===value)))setProductId("")}} options={categoryOptions} placeholder={tr("الفئات")} searchPlaceholder={tr("ابحث عن فئة")} allowEmpty /></div>}<button className="report-print-button"''')
replace_once('app/conta-app.tsx',
'''{["sales","purchases","product-sales","profit","stock"].includes(type)&&<SearchableSelect value={productId}''',
'''{productReport&&<SearchableSelect value={productId}''')
replace_once('app/conta-app.tsx',
'''{type==="sales"&&(productId?<><col''',
'''{type==="sales"&&((productId||categoryId)?<><col''')

# ---------- i18n ----------
replace_once('app/i18n/messages.ts',
'''  "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا": "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا",\n} as const;''',
'''  "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا": "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا",\n  "الفئات": "الفئات",\n  "الفئة": "الفئة",\n  "إضافة فئة": "إضافة فئة",\n  "اسم الفئة": "اسم الفئة",\n  "الفئات الحالية": "الفئات الحالية",\n  "لا توجد فئات حتى الآن": "لا توجد فئات حتى الآن",\n  "تمت إضافة الفئة": "تمت إضافة الفئة",\n  "بدون فئة": "بدون فئة",\n  "ابحث عن فئة": "ابحث عن فئة",\n} as const;''')
replace_once('app/i18n/messages.ts',
'''  "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا": "Le stock des décants ou parfums partiels ne peut pas être corrigé manuellement",\n\n};''',
'''  "لا يمكن تصحيح مخزون التقسيمات أو العطر الناقص يدويًا": "Le stock des décants ou parfums partiels ne peut pas être corrigé manuellement",\n  "الفئات": "Catégories",\n  "الفئة": "Catégorie",\n  "إضافة فئة": "Ajouter une catégorie",\n  "اسم الفئة": "Nom de la catégorie",\n  "الفئات الحالية": "Catégories actuelles",\n  "لا توجد فئات حتى الآن": "Aucune catégorie pour le moment",\n  "تمت إضافة الفئة": "Catégorie ajoutée",\n  "بدون فئة": "Sans catégorie",\n  "ابحث عن فئة": "Rechercher une catégorie",\n\n};''')
replace_once('app/i18n/api-errors.ts',
'''  "تعذر تنفيذ العملية": "Impossible d’effectuer l’opération",''',
'''  "تعذر تنفيذ العملية": "Impossible d’effectuer l’opération",\n  "اسم الفئة مطلوب": "Le nom de la catégorie est obligatoire",\n  "اسم الفئة طويل جدًا": "Le nom de la catégorie est trop long",\n  "هذه الفئة موجودة بالفعل": "Cette catégorie existe déjà",\n  "الفئة غير موجودة": "Catégorie introuvable",''')

# ---------- CSS ----------
with (ROOT/'app/globals.css').open('a', encoding='utf-8') as fh:
    fh.write('''\n\n/* product-categories */\n.product-category-modal{width:min(540px,94vw);display:grid;gap:10px}\n.product-category-create{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:7px}\n.product-category-create label{display:grid;gap:4px;font-size:10px;font-weight:800}\n.product-category-create input,.product-category-create button{height:34px;min-height:34px}\n.product-category-create button{display:flex;align-items:center;gap:5px}.product-category-create button svg{width:15px;height:15px}\n.product-category-list{display:grid;gap:6px;min-height:90px;padding:8px;border:1px solid var(--line);border-radius:6px;background:#fff}\n.product-category-list>div{display:flex;flex-wrap:wrap;gap:5px;max-height:190px;overflow:auto}\n.product-category-list span{padding:5px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel-soft,#f7f9f8);font-size:10px;font-weight:800}\n.product-category-list p{margin:0;color:var(--muted);font-size:10px}\n.report-category-filter{flex:0 0 180px;min-width:160px;max-width:210px}\n.report-category-filter .combobox{width:100%;min-width:0}\n@media(max-width:1050px){.product-category-create{grid-template-columns:1fr}.report-category-filter{flex:1 1 190px;max-width:none}}\n''')

# ---------- structural tests ----------
write('tests/product-categories.test.mjs', '''import assert from "node:assert/strict";\nimport test from "node:test";\nimport { readFile } from "node:fs/promises";\n\nconst source = async path => readFile(new URL(`../${path}`, import.meta.url), "utf8");\n\ntest("product categories are persisted and exposed through bootstrap", async () => {\n  const [domain, bootstrap, command] = await Promise.all([source("app/domain.ts"), source("app/api/bootstrap/route.ts"), source("app/api/command/route.ts")]);\n  assert.match(domain, /interface ProductCategory/);\n  assert.match(domain, /categoryId\?: string \| null/);\n  assert.match(domain, /categories: ProductCategory\[\]/);\n  assert.match(bootstrap, /collection\("productCategories"\)/);\n  assert.match(bootstrap, /categories:cleanCategories/);\n  assert.match(command, /"product-category\.create":"products\.create"/);\n  assert.match(command, /categoryId: categoryId \|\| null/);\n});\n\ntest("products can create categories and assign them while creating or editing", async () => {\n  const ui = await source("app/conta-app.tsx");\n  const dialog = await source("app/product-category-dialog.tsx");\n  assert.match(ui, /ProductCategoryDialog/);\n  assert.match(ui, /tr\("إضافة فئة"\)/);\n  assert.match(ui, /categories=\{data\.categories\}/);\n  assert.match(ui, /\[categoryId, setCategoryId\] = useState\(product\?\.categoryId \?\? ""\)/);\n  assert.match(ui, /wholesalePrice, categoryId, openingStock/);\n  assert.match(dialog, /product-category\.create/);\n});\n\ntest("category report filter sits beside period controls and reaches report backend", async () => {\n  const [ui, filters, reports] = await Promise.all([source("app/conta-app.tsx"), source("app/report-types.ts"), source("lib/reports.ts")]);\n  assert.match(filters, /categoryId\?: string/);\n  assert.match(ui, /add\("categoryId",categoryId\)/);\n  assert.match(ui, /className="report-category-filter"/);\n  assert.match(ui, /CompactDateRange[\s\S]*report-category-filter[\s\S]*report-print-button/);\n  assert.match(reports, /categoryId: text\(url\.searchParams\.get\("categoryId"\)\)/);\n  assert.match(reports, /find\(\{ categoryId: f\.categoryId \}\)/);\n  assert.match(reports, /categoryScope/);\n});\n''')

print('Product categories patch applied successfully')
