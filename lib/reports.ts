import { productsWithCurrentCosts } from "./product-cost.ts";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import type { SqliteDatabase as Db, DbDocument as Document } from "./sqlite.ts";
type FindCursor<T> = ReturnType<Db["collection"]>["find"] extends (...args:any[])=>infer R ? R : never;
import type { ReportFilters, ReportResponse, ReportRow, ReportType } from "../app/report-types.ts";
import { inventoryUnitCost, isProductExpired, resolvePartyType } from "../app/domain.ts";
import { displayDocumentNumber } from "./document-sequences.ts";
import { classifyStockMovementType, stockMovementMatchesFilter } from "../app/stock-movement.ts";

const TYPES: ReportType[] = ["overview", "sales", "purchases", "product-sales", "stock", "profit", "debts", "party-ledger", "financial", "expenses"];
const SALE_KINDS = ["sale", "decant-sale"] as const;
const PURCHASE_KINDS = ["purchase", "decant-purchase"] as const;
const isSaleKind = (kind: unknown) => SALE_KINDS.includes(String(kind) as typeof SALE_KINDS[number]);
const isPurchaseKind = (kind: unknown) => PURCHASE_KINDS.includes(String(kind) as typeof PURCHASE_KINDS[number]);
const REPORT_SORT_KEYS: Record<ReportType, Set<string>> = {
  overview:new Set(),
  sales:new Set(["number","occurredAt","party","paymentMethod","total","cost","profit","product","quantity","revenue"]),
  purchases:new Set(["number","occurredAt","party","paymentMethod","total","paid","due","product","quantity","unitPrice"]),
  "product-sales":new Set(["product","soldQuantity","currentQuantity","netSales","purchasedQuantity","purchases","netPurchases","averagePrice","averagePurchasePrice","profit"]),
  stock:new Set(["occurredAt","product","warehouse","movementType","before","change","after","documentNumber"]),
  profit:new Set(["number","occurredAt","product","quantity","revenue","cost","profit","margin","invoiceCount"]),
  debts:new Set(["name","accountType","phone","balance","lastMovement"]),
  "party-ledger":new Set(["occurredAt","movementType","documentNumber","description","debit","credit","paymentMethod"]),
  financial:new Set(["occurredAt","paymentMethod","movementType","incoming","outgoing","party","documentNumber"]),
  expenses:new Set(["occurredAt","title","recurring","paymentMethod","total","number"]),
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: string | null) => (value ?? "").trim();
const escapeRegex = (value:string) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
const n = (value: unknown) => Number(value ?? 0);
const isoDate = (value: string, next = false) => { const date = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error("التاريخ غير صالح"); if (next) date.setUTCDate(date.getUTCDate() + 1); return date; };

export function parseReportFilters(url: URL): ReportFilters {
  const type = text(url.searchParams.get("type")) as ReportType;
  if (!TYPES.includes(type)) throw new Error("نوع التقرير غير صالح");
  const from = text(url.searchParams.get("from")), to = text(url.searchParams.get("to"));
  const allTime = url.searchParams.get("allTime") === "true", unpaged = url.searchParams.get("unpaged") === "true";
  if (type !== "debts" && !allTime && (!DATE.test(from) || !DATE.test(to))) throw new Error("الفترة مطلوبة");
  if (from && to && isoDate(from) > isoDate(to)) throw new Error("بداية الفترة يجب ألا تتجاوز نهايتها");
  if (from && to && (isoDate(to).valueOf() - isoDate(from).valueOf()) / 86400000 > 3660) throw new Error("الفترة طويلة جدًا");
  const page = Number(url.searchParams.get("page") ?? 1), pageSize = Number(url.searchParams.get("pageSize") ?? 100);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("إعدادات الصفحة غير صالحة");
  const pick = <T extends string>(key: string, allowed: T[], fallback?: T) => { const value = text(url.searchParams.get(key)); if (!value) return fallback; if (!allowed.includes(value as T)) throw new Error(`الفلتر ${key} غير صالح`); return value as T; };
  const sortKey=text(url.searchParams.get("sortKey"))||undefined;
  if(sortKey&&!REPORT_SORT_KEYS[type].has(sortKey))throw new Error("حقل ترتيب التقرير غير صالح");
  return { type, from: from || undefined, to: to || undefined, allTime, unpaged, partyId: text(url.searchParams.get("partyId")) || undefined, productId: text(url.searchParams.get("productId")) || undefined, categoryId: text(url.searchParams.get("categoryId")) || undefined, paymentAccountId: text(url.searchParams.get("paymentAccountId")) || undefined, movementType: text(url.searchParams.get("movementType")) || undefined, direction: pick("direction", ["in", "out"]), groupBy: pick("groupBy", ["invoice", "product"], "invoice"), sortBy: pick("sortBy", ["quantity", "sales", "name", "profit"], "quantity"), sortKey, sortDirection:sortKey?pick("sortDirection",["asc","desc"],"asc"):undefined, debtSide: pick("debtSide", ["receivable", "payable", "clear"]), expenseType: pick("expenseType", ["once", "recurring"]), search: text(url.searchParams.get("search")) || undefined, page, pageSize };
}

/** Stored timestamps are canonical ISO strings, so lexical boundaries are exact and
 * supported by both the SQLite adapter and the former document store. */
const matchDate = (f: ReportFilters): Document => f.allTime ? {} : ({ occurredAt: {
  $gte: isoDate(f.from!).toISOString(),
  $lt: isoDate(f.to!, true).toISOString(),
} });
const pagination = (totalRows: number, f: ReportFilters) => ({ page: f.unpaged ? 1 : f.page, pageSize: f.unpaged ? totalRows : f.pageSize, totalRows, totalPages: f.unpaged ? 1 : Math.max(1, Math.ceil(totalRows / f.pageSize)) });
const slice = <T>(rows: T[], f: ReportFilters) => f.unpaged ? rows : rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
const pageCursor = (cursor: FindCursor<Document>, f: ReportFilters) => f.unpaged ? cursor : cursor.skip((f.page - 1) * f.pageSize).limit(f.pageSize);
const compareReportValue=(a:unknown,b:unknown)=>{if(a==null&&b==null)return 0;if(a==null)return 1;if(b==null)return-1;if(typeof a==="number"&&typeof b==="number")return a-b;const x=String(a),y=String(b);return x.localeCompare(y,undefined,{numeric:true,sensitivity:"base"})};
const sortReportRows=<T extends ReportRow>(rows:T[],f:ReportFilters)=>{if(!f.sortKey)return rows;const direction=f.sortDirection==="desc"?-1:1,key=f.sortKey;return [...rows].sort((a,b)=>compareReportValue(a[key],b[key])*direction)};
const pageReportRows=<T>(rows:T[],f:ReportFilters)=>f.unpaged?rows:rows.slice((f.page-1)*f.pageSize,f.page*f.pageSize);
type ProductScope = Set<string> | null;
const lineMatches = (line: Document, f: ReportFilters, categoryScope: ProductScope = null) => (!f.productId || String(line.productId) === f.productId) && (!categoryScope || categoryScope.has(String(line.productId)));
const productConstraint = (f: ReportFilters, categoryScope: ProductScope) => f.productId || (categoryScope ? { $in: [...categoryScope] } : undefined);

export const OPERATING_FINANCIAL_TYPES = new Set(["sale", "purchase", "decant-sale", "decant-purchase", "expense", "party-receipt", "party-payment"]);
export const financialMovementKind = (type: unknown) => { const value=String(type??""); if(value==="decant-sale"||value.startsWith("sale:"))return "sale"; if(value==="decant-purchase"||value.startsWith("purchase:"))return "purchase"; return value; };
export const isOperatingFinancialMovement = (type: unknown) => OPERATING_FINANCIAL_TYPES.has(financialMovementKind(type));

type Cost = { unit: number | null; source: "snapshot" | "historical-purchase" | "historical-opening" | "unknown" };

/** Applies persisted legacy sale adjustments read-only so historical accounting remains stable. */
async function saleFacts(db: Db, documents: Document[], f: ReportFilters, categoryScope: ProductScope = null) {
  const facts: ReportRow[] = [];
  const productIds = [...new Set(documents.flatMap(document => ((document.lines ?? []) as Document[]).map(line => String(line.productId ?? "")).filter(Boolean)))];
  const parentIds=[...new Set(documents.filter(document=>document.kind==="return"&&document.parentDocumentId).map(document=>String(document.parentDocumentId)))];
  const [identityRows,parentRows,purchaseRows,openingRows]=await Promise.all([
    db.collection("products").find({ id: { $in: productIds } }).project({ id: 1, name: 1, sku: 1 }).toArray(),
    db.collection("documents").find({id:{$in:parentIds},kind:{$in:[...SALE_KINDS]}}).project({id:1,occurredAt:1}).toArray(),
    productIds.length?db.collection("documents").find({kind:{$in:[...PURCHASE_KINDS]},status:"posted","lines.productId":{$in:productIds}}).project({occurredAt:1,lines:1}).sort({occurredAt:1}).toArray():Promise.resolve([]),
    productIds.length?db.collection("documents").find({kind:"adjustment",status:"posted","lines.productId":{$in:productIds}}).project({number:1,openingCorrection:1,occurredAt:1,lines:1}).sort({occurredAt:1}).toArray():Promise.resolve([]),
  ]);
  const identities = new Map(identityRows.map(product => [String(product.id), product])),parentDates=new Map(parentRows.map(document=>[String(document.id),String(document.occurredAt)])),purchaseHistory=new Map<string,Array<{at:string;unit:number}>>(),openingHistory=new Map<string,Array<{at:string;unit:number}>>();
  for(const purchase of purchaseRows)for(const purchaseLine of (purchase.lines??[]) as Document[]){const key=String(purchaseLine.productId);if(!productIds.includes(key)||!Number.isFinite(Number(purchaseLine.unitPrice)))continue;const rows=purchaseHistory.get(key)??[];rows.push({at:String(purchase.occurredAt),unit:n(purchaseLine.unitPrice)});purchaseHistory.set(key,rows)}
  for(const opening of openingRows){if(!(opening.openingCorrection===true||String(opening.number??"").startsWith("OPEN-")))continue;for(const openingLine of (opening.lines??[]) as Document[]){const key=String(openingLine.productId),unit=Number(openingLine.unitPrice);if(!productIds.includes(key)||!Number.isFinite(unit)||unit<=0)continue;const rows=openingHistory.get(key)??[];rows.push({at:String(opening.occurredAt),unit});openingHistory.set(key,rows)}}
  for (const document of documents) for (const line of (document.lines ?? []) as Document[]) {
    if (!lineMatches(line, f, categoryScope)) continue;
    const sign = document.kind === "return" ? -1 : 1;
    // Legacy read-only adjustments normally carry the original line cost. Records that do
    // not carry it must resolve at the original sale date, never the return date.
    const costDate=document.kind==="return"&&document.parentDocumentId?parentDates.get(String(document.parentDocumentId))??String(document.occurredAt):String(document.occurredAt);
    const historical=[...(purchaseHistory.get(String(line.productId))??[])].reverse().find(row=>row.at<=costDate),historicalOpening=[...(openingHistory.get(String(line.productId))??[])].reverse().find(row=>row.at<=costDate);
    const cost:Cost=line.costAtSale!==null&&line.costAtSale!==undefined&&Number.isFinite(Number(line.costAtSale))?{unit:n(line.costAtSale),source:"snapshot"}:historical?{unit:historical.unit,source:"historical-purchase"}:historicalOpening?{unit:historicalOpening.unit,source:"historical-opening"}:{unit:null,source:"unknown"};
    const revenue = sign * n(line.lineTotal), quantity = sign * n(line.quantity), costKnown = cost.unit !== null, cogs = sign * n(line.quantity) * (cost.unit ?? 0), profit = revenue - cogs;
    const identity = identities.get(String(line.productId));
    const productName = String(identity?.name ?? line.description ?? "").trim() || "منتج غير متاح";
    const sku = String(identity?.sku ?? line.sku ?? "").trim() || "—";
    facts.push({ id: `${document.id}-${line.id}`, documentId: String(document.id), parentDocumentId: String(document.parentDocumentId ?? ""), number: displayDocumentNumber(document), occurredAt: String(document.occurredAt), party: String(document.partyName ?? "بيع مباشر"), partyId: String(document.partyId ?? ""), paymentMethod: String(document.paymentMethod ?? ""), productId: String(line.productId), product: productName, sku, quantity, unitPrice: n(line.unitPrice), revenue, cost: cogs, profit, margin: revenue ? profit / revenue * 100 : 0, costKnown, costSource: cost.source, unknownRevenue: costKnown ? 0 : Math.abs(revenue) });
  }
  return facts;
}

function profitSummary(facts: ReportRow[]) {
  const revenue = facts.reduce((sum, row) => sum + n(row.revenue), 0), cost = facts.reduce((sum, row) => sum + n(row.cost), 0), profit = facts.reduce((sum, row) => sum + n(row.profit), 0);
  return { revenue, cost, profit, margin: revenue ? profit / revenue * 100 : 0, unknownRevenue: facts.reduce((sum, row) => sum + n(row.unknownRevenue), 0) };
}

/** Current expired stock is a non-cash inventory exposure: reporting never mutates stock or accounts. */
async function expiredInventoryLoss(db: Db) {
  const today = new Date().toISOString().slice(0, 10);
  const products = await productsWithCurrentCosts(db, await db.collection("products").find({ expiryDate: { $type: "string", $lt: today }, isArchived: { $ne: true } }).toArray());
  return products.reduce((total, product) => {
    if (!isProductExpired(product, today)) return total;
    const remaining = Object.values((product.stocks ?? {}) as Record<string, number>).reduce((sum, quantity) => sum + Math.max(0, n(quantity)), 0);
    const cost = inventoryUnitCost(product);
    return total + remaining * cost;
  }, 0);
}

async function directDocuments(db: Db, f: ReportFilters, kind: string | readonly string[], categoryScope: ProductScope = null) {
  const query: Document = { kind: Array.isArray(kind) ? { $in: [...kind] } : kind, status: "posted", ...matchDate(f) };
  if (f.paymentAccountId) query.paymentMethod = f.paymentAccountId;
  const constraint = productConstraint(f, categoryScope);
  if (constraint) query["lines.productId"] = constraint;
  if (kind === "expense" && f.expenseType) query.recurringId = f.expenseType === "recurring" ? { $exists: true } : { $exists: false };
  const all = await db.collection("documents").find(query).toArray();
  const ordered = [...all].sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt)));
  const totalRows = all.length, rows = f.unpaged ? ordered : ordered.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
  return { rows, all, ordered, totalRows };
}

export async function buildReport(db: Db, f: ReportFilters): Promise<ReportResponse> {
  const categoryScope: ProductScope = f.categoryId ? new Set((await db.collection("products").find({ categoryId: f.categoryId }).project({ id: 1 }).toArray()).map(product => String(product.id))) : null;
  const constraint = productConstraint(f, categoryScope), hasProductFilter = Boolean(f.productId || f.categoryId);
  const expiryLoss = ["stock", "profit", "overview"].includes(f.type) ? await expiredInventoryLoss(db) : 0;
  if (f.type === "sales") {
    const sales = await directDocuments(db, f, SALE_KINDS, categoryScope);
    // Read-only compatibility: fold persisted adjustments into net sales; never expose a KPI.
    const returnQuery = { kind: "return", status: "posted", ...matchDate(f), ...(constraint ? { "lines.productId": constraint } : {}) };
    const legacySaleAdjustments = await db.collection("documents").find(returnQuery).toArray();
    const summaryFacts = await saleFacts(db, [...sales.all, ...legacySaleAdjustments], f, categoryScope), totals = profitSummary(summaryFacts);
    const factsByDocument=new Map<string,ReportRow[]>();for(const fact of summaryFacts){const key=String(fact.documentId),rows=factsByDocument.get(key)??[];rows.push(fact);factsByDocument.set(key,rows)}
    const allRows:ReportRow[]=hasProductFilter?sales.ordered.flatMap(document=>factsByDocument.get(String(document.id))??[]):sales.ordered.map(document=>{const p=profitSummary(factsByDocument.get(String(document.id))??[]);return{id:String(document.id),documentId:String(document.id),number:displayDocumentNumber(document),occurredAt:String(document.occurredAt),party:String(document.partyName??"بيع مباشر"),paymentMethod:String(document.paymentMethod??""),total:n(document.total),cost:p.cost,profit:p.profit,margin:n(document.total)?p.profit/n(document.total)*100:0,paid:n(document.paidTotal),due:n(document.dueTotal)}});
    const rows=pageReportRows(sortReportRows(allRows,f),f);
    return { report: f.type, from: f.from!, to: f.to!, summary: { count: sales.totalRows, grossSales: sales.all.reduce((sum, document) => sum + (hasProductFilter ? (document.lines as Document[]).filter(line => lineMatches(line, f, categoryScope)).reduce((lineSum,line)=>lineSum+n(line.lineTotal),0) : n(document.total)), 0), netSales: totals.revenue, cost: totals.cost, profit: totals.profit, margin: totals.margin, unknownRevenue: totals.unknownRevenue, paid: sales.all.reduce((sum,document)=>sum+n(document.paidTotal),0), due: sales.all.reduce((sum,document)=>sum+n(document.dueTotal),0) }, rows, meta: pagination(allRows.length, f) };
  }
  if (f.type === "purchases" || f.type === "expenses") {
    const kind = f.type === "purchases" ? PURCHASE_KINDS : "expense", found = await directDocuments(db, f, kind, categoryScope);
    const productIds = [...new Set(found.all.flatMap(document => ((document.lines ?? []) as Document[]).map(line => String(line.productId ?? "")).filter(Boolean)))];
    const identities = new Map((await db.collection("products").find({ id: { $in: productIds } }).project({ id: 1, name: 1, sku: 1 }).toArray()).map(product => [String(product.id), product]));
    const partyIds=[...new Set(found.all.map(document=>String(document.partyId??"")).filter(Boolean))],partyNames=new Map((partyIds.length?await db.collection("parties").find({id:{$in:partyIds}}).project({id:1,name:1}).toArray():[]).map(party=>[String(party.id),String(party.name)]));
    const allRows:ReportRow[]=found.ordered.flatMap<ReportRow>(document=>{const selected=((document.lines??[]) as Document[]).filter(line=>lineMatches(line,f,categoryScope)),party=String(partyNames.get(String(document.partyId))??document.partyName??"");if(f.type==="purchases"&&hasProductFilter)return selected.map(line=>({id:`${document.id}-${line.id??line.productId}`,documentId:String(document.id),number:displayDocumentNumber(document),occurredAt:String(document.occurredAt),party,product:String(identities.get(String(line.productId))?.name??line.description??"").trim()||"منتج غير متاح",sku:String(identities.get(String(line.productId))?.sku??line.sku??"—")||"—",quantity:n(line.quantity),unitPrice:n(line.unitPrice),total:n(line.lineTotal)}));return[{id:String(document.id),documentId:String(document.id),number:displayDocumentNumber(document),occurredAt:String(document.occurredAt),party,paymentMethod:String(document.paymentMethod??""),title:String(document.title??""),recurring:Boolean(document.recurringId),total:n(document.total),paid:n(document.paidTotal),due:n(document.dueTotal)}]});
    const rows=pageReportRows(sortReportRows(allRows,f),f),value=(document:Document)=>hasProductFilter?(document.lines as Document[]).filter(line=>lineMatches(line,f,categoryScope)).reduce((sum,line)=>sum+n(line.lineTotal),0):n(document.total);
    return { report:f.type,from:f.from!,to:f.to!,summary:{count:found.totalRows,total:found.all.reduce((sum,document)=>sum+value(document),0),quantity:found.all.reduce((sum,document)=>sum+(document.lines as Document[]).filter(line=>lineMatches(line,f,categoryScope)).reduce((lineSum,line)=>lineSum+n(line.quantity),0),0),paid:found.all.reduce((sum,document)=>sum+n(document.paidTotal),0),due:found.all.reduce((sum,document)=>sum+n(document.dueTotal),0),recurringTotal:found.all.filter(document=>Boolean(document.recurringId)).reduce((sum,document)=>sum+n(document.total),0),oneOffTotal:found.all.filter(document=>!document.recurringId).reduce((sum,document)=>sum+n(document.total),0)},rows,meta:pagination(allRows.length,f) };
  }
  if (f.type === "stock") {
    const query:Document=matchDate(f);if(constraint)query.productId=constraint;
    const stored=await db.collection("stockMovements").find(query).toArray() as Array<Record<string,unknown>>,documentIds=[...new Set(stored.map(row=>String(row.documentId??"")).filter(Boolean))];
    const documents=(documentIds.length?await db.collection("documents").find({id:{$in:documentIds}}).project({id:1,number:1,kind:1,title:1,openingCorrection:1,openingStockBefore:1,openingStockAfter:1}).toArray():[]) as Array<Record<string,unknown>>,documentMap=new Map(documents.map(document=>[String(document.id),document]));
    const classified:Array<Record<string,unknown>&{type:string}>=stored.map(row=>({...row,type:classifyStockMovementType(row.type,documentMap.get(String(row.documentId??"")))})),all=f.movementType?classified.filter(row=>stockMovementMatchesFilter(row.type,f.movementType)):classified,ordered=[...all].sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt)));
    const products=await db.collection("products").find({id:{$in:ordered.map(row=>row.productId)}}).project({id:1,sku:1,name:1}).toArray(),identities=new Map(products.map(product=>[String(product.id),product]));
    const allRows:ReportRow[]=ordered.map(row=>({id:String(row.id),documentId:String(row.documentId),occurredAt:String(row.occurredAt),sku:String(identities.get(String(row.productId))?.sku??row.sku??"—")||"—",product:String(identities.get(String(row.productId))?.name??row.productName??"").trim()||"منتج غير متاح",warehouse:String(row.warehouseName),movementType:String(row.type),before:n(row.balanceBefore),change:n(row.quantityDelta),after:n(row.balanceAfter),documentNumber:String(row.documentNumber)})),rows=pageReportRows(sortReportRows(allRows,f),f),totalRows=allRows.length;
    return {report:f.type,from:f.from!,to:f.to!,summary:{movements:totalRows,expiredInventoryLoss:expiryLoss,incoming:all.reduce((sum,row)=>sum+Math.max(0,n(row.quantityDelta)),0),outgoing:all.reduce((sum,row)=>sum+Math.abs(Math.min(0,n(row.quantityDelta))),0),netChange:all.reduce((sum,row)=>sum+n(row.quantityDelta),0)},rows,meta:pagination(totalRows,f)};
  }
  if (f.type === "financial") {
    const query:Document={...matchDate(f),status:{$ne:"reversed"},isReversal:{$ne:true}};if(f.movementType)query.type=f.movementType==="sale"?{$regex:"^(?:sale(?::|$)|decant-sale$)"}:f.movementType==="purchase"?{$regex:"^(?:purchase(?::|$)|decant-purchase$)"}:f.movementType;if(f.paymentAccountId)query.paymentMethod=f.paymentAccountId;if(f.direction)query.direction=f.direction;
    const all=await db.collection("financialMovements").find(query).toArray(),ordered=[...all].sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))),allRows:ReportRow[]=ordered.map(row=>({id:String(row.id),documentId:String(row.documentId),occurredAt:String(row.occurredAt),paymentMethod:String(row.paymentMethod),movementType:financialMovementKind(row.type),incoming:row.direction==="in"?n(row.amount):0,outgoing:row.direction==="out"?n(row.amount):0,party:String(row.partyName??""),documentNumber:String(row.documentNumber??"")})),rows=pageReportRows(sortReportRows(allRows,f),f),totalRows=allRows.length;
    const operating=all.filter(row=>isOperatingFinancialMovement(row.type)),businessIncoming=operating.filter(row=>row.direction==="in").reduce((sum,row)=>sum+n(row.amount),0),businessOutgoing=operating.filter(row=>row.direction==="out").reduce((sum,row)=>sum+n(row.amount),0),balanceNet=all.reduce((sum,row)=>sum+(row.direction==="in"?n(row.amount):-n(row.amount)),0);
    return {report:f.type,from:f.from!,to:f.to!,summary:{incoming:all.filter(row=>row.direction==="in").reduce((sum,row)=>sum+n(row.amount),0),outgoing:all.filter(row=>row.direction==="out").reduce((sum,row)=>sum+n(row.amount),0),net:balanceNet,businessIncoming,businessOutgoing,businessNet:businessIncoming-businessOutgoing,balanceNet,operatingIncoming:businessIncoming,operatingOutgoing:businessOutgoing,operatingNet:businessIncoming-businessOutgoing},rows,meta:pagination(totalRows,f)};
  }
  if (f.type === "debts") {
    const query:Document={isArchived:{$ne:true}};if(f.search){const literal=escapeRegex(f.search);query.$or=[{name:{$regex:literal,$options:"i"}},{phone:{$regex:literal}}]};if(f.debtSide==="receivable")query.receivable={$gt:0};if(f.debtSide==="payable")query.payable={$gt:0};if(f.debtSide==="clear")query.$and=[{receivable:{$lte:0}},{payable:{$lte:0}}];
    const all=await db.collection("parties").find(query).toArray(),allRows:ReportRow[]=all.map(party=>({id:String(party.id),partyId:String(party.id),name:String(party.name),phone:String(party.phone??""),partyType:String(party.partyType),accountType:party.partyType==="customer"?"عميل":"مورد",balance:Math.abs(n(party.receivable)-n(party.payable)),receivable:Math.max(n(party.receivable)-n(party.payable),0),payable:Math.max(n(party.payable)-n(party.receivable),0),lastMovement:String(party.lastMovementAt??"")})).sort((a,b)=>compareReportValue(a.name,b.name)),rows=pageReportRows(sortReportRows(allRows,f),f),total=allRows.length;
    return{report:f.type,from:null,to:null,summary:{receivable:all.reduce((sum,party)=>sum+Math.max(n(party.receivable)-n(party.payable),0),0),payable:all.reduce((sum,party)=>sum+Math.max(n(party.payable)-n(party.receivable),0),0),net:all.reduce((sum,party)=>sum+n(party.receivable)-n(party.payable),0),count:total},rows,meta:pagination(total,f)};
  }
  if (f.type === "party-ledger") {
    if(!f.partyId)throw new Error("يجب اختيار الطرف");const party=await db.collection("parties").findOne({id:f.partyId});if(!party)throw new Error("الطرف غير موجود");
    const partyType=resolvePartyType(party),query={partyId:f.partyId,status:"posted",kind:{$in:[...SALE_KINDS,...PURCHASE_KINDS,"return","payment","offset","settlement"]},...matchDate(f)},all=await db.collection("documents").find(query).toArray(),parentIds=all.filter(document=>document.kind==="return"&&document.parentDocumentId).map(document=>document.parentDocumentId),parentKinds=new Map((await db.collection("documents").find({id:{$in:parentIds}}).project({id:1,kind:1}).toArray()).map(document=>[String(document.id),String(document.kind)]));
    const effect=(document:Document)=>{if(Number.isFinite(Number(document.partyBalanceDelta)))return n(document.partyBalanceDelta);if(isSaleKind(document.kind))return n(document.dueTotal);if(isPurchaseKind(document.kind))return-n(document.dueTotal);if(document.kind==="return")return-Math.max(0,n(document.total)-n(document.paidTotal));if(document.kind==="offset")return 0;if(document.kind==="payment"&&document.partyCashDirection)return document.partyCashDirection==="receive"?-n(document.total):n(document.total);if(document.kind==="payment"||document.kind==="settlement")return String(document.title).includes("دفع لنا")?-n(document.total):n(document.total);return 0};
    const role=partyType==="customer"?"العميل":"المورد",movementLabel=(document:Document)=>document.kind==="decant-sale"?"فاتورة التقسيمات":document.kind==="decant-purchase"?"فاتورة شراء زجاج التقسيمات":document.kind==="sale"?"فاتورة بيع":document.kind==="purchase"?"فاتورة شراء":document.kind==="return"?"حركة تاريخية":document.kind==="offset"?"مقاصة":document.kind==="settlement"?"تسوية":document.partyCashDirection==="receive"?`استلام من ${role}`:document.partyCashDirection==="pay"?(partyType==="customer"?"دفع للعميل":"دفع للمورد"):"دفعة";
    const allRows:ReportRow[]=[...all].sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))).map(document=>{const delta=effect(document);return{id:String(document.id),documentId:String(document.id),occurredAt:String(document.occurredAt),movementType:movementLabel(document),documentNumber:displayDocumentNumber(document),description:String(document.title??document.partyName??""),debit:Math.max(delta,0),credit:Math.max(-delta,0),paymentMethod:String(document.paymentMethod??"")}}),rows=pageReportRows(sortReportRows(allRows,f),f),total=allRows.length;
    const tradeTotal=partyType==="customer"?all.reduce((sum,document)=>sum+(isSaleKind(document.kind)?n(document.total):document.kind==="return"&&!isPurchaseKind(parentKinds.get(String(document.parentDocumentId)))?-n(document.total):0),0):all.reduce((sum,document)=>sum+(isPurchaseKind(document.kind)?n(document.total):document.kind==="return"&&isPurchaseKind(parentKinds.get(String(document.parentDocumentId)))?-n(document.total):0),0),net=n(party.receivable)-n(party.payable),debitTotal=all.reduce((sum,document)=>sum+Math.max(effect(document),0),0),creditTotal=all.reduce((sum,document)=>sum+Math.max(-effect(document),0),0);
    return{report:f.type,from:f.from??null,to:f.to??null,summary:{name:String(party.name),partyType,tradeTotal,debitTotal,creditTotal,receivable:Math.max(net,0),payable:Math.max(-net,0),net,transactionCount:total},rows,meta:pagination(total,f)};
  }
  // Read-only compatibility: legacy adjustments remain negative sale facts.
  const overviewCommercial=f.type==="overview"?await db.collection("documents").find({kind:{$in:[...SALE_KINDS,"return",...PURCHASE_KINDS,"expense"]},status:"posted",...matchDate(f)}).toArray():null;
  const documents=overviewCommercial?overviewCommercial.filter(document=>(isSaleKind(document.kind)||document.kind==="return")&&(!constraint||(document.lines??[]).some((line:Document)=>lineMatches(line,f,categoryScope)))):await db.collection("documents").find({kind:{$in:[...SALE_KINDS,"return"]},status:"posted",...matchDate(f),...(constraint?{"lines.productId":constraint}:{})}).toArray(),facts=await saleFacts(db,documents,f,categoryScope);
  if(f.type==="product-sales"){
    const purchases=await db.collection("documents").find({kind:{$in:[...PURCHASE_KINDS]},status:"posted",...matchDate(f),...(constraint?{"lines.productId":constraint}:{})}).project({lines:1}).toArray();
    const activeWarehouses=new Set((await db.collection("warehouses").find({isArchived:{$ne:true}}).project({_id:1}).toArray()).map(warehouse=>String(warehouse._id)));
    const productQuery:Document={...(f.productId?{id:f.productId}:f.categoryId?{categoryId:f.categoryId}:{})};
    const productRows=await db.collection("products").find(productQuery).project({id:1,sku:1,name:1,stocks:1}).toArray(),map=new Map<string,ReportRow>();
    for(const product of productRows)map.set(String(product.id),{id:String(product.id),productId:String(product.id),sku:String(product.sku??"—")||"—",product:String(product.name??"").trim()||"منتج غير متاح",soldQuantity:0,currentQuantity:Object.entries((product.stocks??{}) as Record<string,unknown>).filter(([warehouseId])=>activeWarehouses.has(warehouseId)).reduce((sum,[,quantity])=>sum+n(quantity),0),netSales:0,purchasedQuantity:0,purchases:0,netPurchases:0,averagePrice:0,averagePurchasePrice:0,profit:0,costKnown:true});
    for(const fact of facts){const key=String(fact.productId),row=map.get(key);if(!row)continue;row.soldQuantity=n(row.soldQuantity)+n(fact.quantity);row.netSales=n(row.netSales)+n(fact.revenue);row.averagePrice=n(row.soldQuantity)?n(row.netSales)/n(row.soldQuantity):0;row.costKnown=Boolean(row.costKnown)&&Boolean(fact.costKnown);row.profit=n(row.profit)+n(fact.profit)}
    for(const purchase of purchases)for(const line of (purchase.lines??[]) as Document[]){const row=map.get(String(line.productId));if(!row)continue;row.purchasedQuantity=n(row.purchasedQuantity)+n(line.quantity);row.purchases=n(row.purchases)+n(line.lineTotal);row.netPurchases=n(row.purchases);row.averagePurchasePrice=n(row.purchasedQuantity)?n(row.purchases)/n(row.purchasedQuantity):0}
    const allRows=[...map.values()],rows=pageReportRows(sortReportRows(allRows,f),f);return{report:f.type,from:f.from!,to:f.to!,summary:{products:allRows.length,quantity:allRows.reduce((sum,row)=>sum+n(row.currentQuantity),0),sales:allRows.reduce((sum,row)=>sum+n(row.netSales),0),purchases:allRows.reduce((sum,row)=>sum+n(row.netPurchases),0),profit:allRows.reduce((sum,row)=>sum+n(row.profit),0),unknownRevenue:facts.reduce((sum,row)=>sum+n(row.unknownRevenue),0)},rows,meta:pagination(allRows.length,f)};
  }
  const grouped=new Map<string,ReportRow>();for(const fact of facts){const key=f.groupBy==="product"?String(fact.productId):String(fact.documentId),g=grouped.get(key)??{id:key,documentId:fact.documentId,number:fact.number,occurredAt:fact.occurredAt,productId:fact.productId,product:fact.product,sku:fact.sku,quantity:0,revenue:0,cost:0,profit:0,unknownRevenue:0,costKnown:true,invoiceIdList:""};g.quantity=n(g.quantity)+n(fact.quantity);g.revenue=n(g.revenue)+n(fact.revenue);g.cost=n(g.cost)+n(fact.cost);g.profit=n(g.profit)+n(fact.profit);g.unknownRevenue=n(g.unknownRevenue)+n(fact.unknownRevenue);g.costKnown=Boolean(g.costKnown)&&Boolean(fact.costKnown);const ids=new Set(String(g.invoiceIdList).split(",").filter(Boolean));ids.add(String(fact.documentId));g.invoiceIdList=[...ids].join(",");g.invoiceCount=ids.size;g.margin=n(g.revenue)?n(g.profit)/n(g.revenue)*100:0;grouped.set(key,g)}const prows=[...grouped.values()].map(row=>{const copy={...row};delete copy.invoiceIdList;return copy}).sort((a,b)=>n(b.profit)-n(a.profit));if(f.type==="profit"){const rows=pageReportRows(sortReportRows(prows,f),f);return{report:f.type,from:f.from!,to:f.to!,summary:{...profitSummary(facts),expiredInventoryLoss:expiryLoss},rows,meta:pagination(prows.length,f)}};
  // Overview totals include legacy effects, while the invoice list below hides that retired kind.
  const commercial=overviewCommercial??await db.collection("documents").find({kind:{$in:[...SALE_KINDS,"return",...PURCHASE_KINDS,"expense"]},status:"posted",...matchDate(f)}).toArray();
  // These collections are intentionally unfiltered by the report period: the lower
  // overview is a current position snapshot, while `commercial` remains period-bound.
  const [parties,accounts,products,warehouses]=await Promise.all([
    db.collection("parties").find({isArchived:{$ne:true}}).sort({name:1}).toArray(),
    db.collection("paymentAccounts").find({isArchived:{$ne:true}}).sort({createdAt:1,name:1}).toArray(),
    // Archived products remain here because their on-hand stock still has value.
    db.collection("products").find().toArray().then(rows => productsWithCurrentCosts(db, rows)),
    db.collection("warehouses").find().sort({createdAt:1,name:1}).toArray(),
  ]);
  const factsByDocument=new Map<string,{cost:number;profit:number}>();for(const fact of facts){const key=String(fact.documentId),current=factsByDocument.get(key)??{cost:0,profit:0};current.cost+=n(fact.cost);current.profit+=n(fact.profit);factsByDocument.set(key,current)}
  const kindRank:Record<string,number>={sale:0,"decant-sale":1,purchase:2,"decant-purchase":3,expense:4};
  const invoices=commercial.filter(d=>d.kind!=="return").map(d=>{const kind=String(d.kind) as "sale"|"decant-sale"|"purchase"|"decant-purchase"|"expense",value=n(d.total),saleFact=factsByDocument.get(String(d.id)),saleLike=isSaleKind(kind);return{id:String(d.id),documentId:String(d.id),kind,type:kind==="decant-sale"?"فاتورة التقسيمات":kind==="decant-purchase"?"فاتورة شراء زجاج التقسيمات":kind==="sale"?"فاتورة بيع":kind==="purchase"?"فاتورة شراء":"فاتورة مصروفات",number:displayDocumentNumber(d),sequence:Number.isSafeInteger(Number(d.sequence))&&n(d.sequence)>0?n(d.sequence):null,occurredAt:String(d.occurredAt),invoiceValue:value,cost:saleLike?(saleFact?.cost??0):value,profit:saleLike?(saleFact?.profit??value):null}}).sort((a,b)=>kindRank[a.kind]-kindRank[b.kind]||((a.sequence??Number.MAX_SAFE_INTEGER)-(b.sequence??Number.MAX_SAFE_INTEGER))||a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
  const typedParties=parties.map(p=>({...p,partyType:resolvePartyType(p)} as Document & {partyType:"customer"|"supplier"}));
  const partyRows=typedParties.map(p=>({id:String(p.id),partyId:String(p.id),name:String(p.name),partyType:p.partyType,receivable:Math.max(n(p.receivable)-n(p.payable),0),payable:Math.max(n(p.payable)-n(p.receivable),0)}));
  const bankAccounts=accounts.map(a=>({id:String(a.id??a._id),name:String(a.name),balance:n(a.balance)}));
  const currentAccountsBalance=bankAccounts.reduce((v,a)=>v+a.balance,0);
  const warehouseValues=warehouses.map(warehouse=>{
    const id=String(warehouse.id??warehouse._id);
    const value=products.reduce((sum,product)=>sum+n(product.stocks?.[id])*inventoryUnitCost({lastPurchaseCost:Number.isFinite(product.lastPurchaseCost)?n(product.lastPurchaseCost):null,openingCost:Number.isFinite(product.openingCost)?n(product.openingCost):null,legacyOpeningCost:Number.isFinite(product.legacyOpeningCost)?n(product.legacyOpeningCost):null}),0);
    return {id,name:String(warehouse.name),value,archived:warehouse.isArchived===true};
  }).filter(warehouse=>!warehouse.archived||warehouse.value!==0);
  const currentInventoryValue=warehouseValues.reduce((sum,warehouse)=>sum+warehouse.value,0);
  const currentReceivable=typedParties.reduce((v,p)=>v+Math.max(n(p.receivable)-n(p.payable),0),0);
  const currentPayable=typedParties.reduce((v,p)=>v+Math.max(n(p.payable)-n(p.receivable),0),0);
  const p=profitSummary(facts),sales=commercial.filter(d=>isSaleKind(d.kind)).reduce((v,d)=>v+n(d.total),0)-commercial.filter(d=>d.kind==="return").reduce((v,d)=>v+n(d.total),0),expenses=commercial.filter(d=>d.kind==="expense").reduce((v,d)=>v+n(d.total),0);
  const detailRow=(d:Document,value:number)=>({id:String(d.id),documentId:String(d.id),number:displayDocumentNumber(d),occurredAt:String(d.occurredAt),kind:String(d.kind) as "sale"|"decant-sale"|"return"|"purchase"|"decant-purchase"|"expense",value});
  const salesDetails=commercial.filter(d=>isSaleKind(d.kind)||d.kind==="return").map(d=>detailRow(d,d.kind==="return"?-n(d.total):n(d.total)));
  const purchaseDetails=commercial.filter(d=>isPurchaseKind(d.kind)).map(d=>detailRow(d,n(d.total)));
  const expenseDetails=commercial.filter(d=>d.kind==="expense").map(d=>detailRow(d,n(d.total)));
  const salesProfitDetails=commercial.filter(d=>d.kind==="sale"||d.kind==="return").map(d=>{const fact=factsByDocument.get(String(d.id))??{cost:0,profit:0};return{...detailRow(d,n(fact.profit)),revenue:d.kind==="return"?-n(d.total):n(d.total),cost:n(fact.cost),profit:n(fact.profit)}});
  return{report:"overview",from:f.from!,to:f.to!,summary:{sales,salesCost:p.cost,salesProfit:p.profit,purchases:commercial.filter(d=>isPurchaseKind(d.kind)).reduce((v,d)=>v+n(d.total),0),expenses,netOperatingResult:p.profit-expenses,profit:p.profit,currentReceivable,currentPayable,currentInventoryValue,currentAccountsBalance,customerReceivables:currentReceivable,supplierPayables:currentPayable,bankBalance:currentAccountsBalance,inventoryValue:currentInventoryValue,customerCount:typedParties.filter(p=>p.partyType==="customer").length,supplierCount:typedParties.filter(p=>p.partyType==="supplier").length},rows:[],invoices,parties:partyRows,bankAccounts,warehouseValues,overviewDetails:{sales:salesDetails,purchases:purchaseDetails,expenses:expenseDetails,salesProfit:salesProfitDetails},meta:pagination(invoices.length,f)};

}
