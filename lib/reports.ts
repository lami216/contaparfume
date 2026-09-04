/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import type { SqliteDatabase as Db, DbDocument as Document } from "./sqlite.ts";
type FindCursor<T> = ReturnType<Db["collection"]>["find"] extends (...args:any[])=>infer R ? R : never;
import type { ReportFilters, ReportResponse, ReportRow, ReportType } from "../app/report-types.ts";
import { inventoryUnitCost, isProductExpired, resolvePartyType } from "../app/domain.ts";
import { displayDocumentNumber } from "./document-sequences.ts";

const TYPES: ReportType[] = ["overview", "sales", "purchases", "product-sales", "stock", "profit", "debts", "party-ledger", "financial", "expenses"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: string | null) => (value ?? "").trim();
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
  return { type, from: from || undefined, to: to || undefined, allTime, unpaged, partyId: text(url.searchParams.get("partyId")) || undefined, productId: text(url.searchParams.get("productId")) || undefined, paymentAccountId: text(url.searchParams.get("paymentAccountId")) || undefined, movementType: text(url.searchParams.get("movementType")) || undefined, direction: pick("direction", ["in", "out"]), groupBy: pick("groupBy", ["invoice", "product"], "invoice"), sortBy: pick("sortBy", ["quantity", "sales", "name", "profit"], "quantity"), debtSide: pick("debtSide", ["receivable", "payable", "clear"]), expenseType: pick("expenseType", ["once", "recurring"]), search: text(url.searchParams.get("search")) || undefined, page, pageSize };
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
const lineMatches = (line: Document, f: ReportFilters) => !f.productId || String(line.productId) === f.productId;

export const OPERATING_FINANCIAL_TYPES = new Set(["sale", "purchase", "expense", "party-receipt", "party-payment"]);
export const isOperatingFinancialMovement = (type: unknown) => OPERATING_FINANCIAL_TYPES.has(String(type));

type Cost = { unit: number | null; source: "snapshot" | "historical-purchase" | "unknown" };

/** Applies persisted legacy sale adjustments read-only so historical accounting remains stable. */
async function saleFacts(db: Db, documents: Document[], f: ReportFilters) {
  const facts: ReportRow[] = [];
  const productIds = [...new Set(documents.flatMap(document => ((document.lines ?? []) as Document[]).map(line => String(line.productId ?? "")).filter(Boolean)))];
  const parentIds=[...new Set(documents.filter(document=>document.kind==="return"&&document.parentDocumentId).map(document=>String(document.parentDocumentId)))];
  const [identityRows,parentRows,purchaseRows]=await Promise.all([
    db.collection("products").find({ id: { $in: productIds } }).project({ id: 1, name: 1, sku: 1 }).toArray(),
    db.collection("documents").find({id:{$in:parentIds},kind:"sale"}).project({id:1,occurredAt:1}).toArray(),
    productIds.length?db.collection("documents").find({kind:"purchase",status:"posted","lines.productId":{$in:productIds}}).project({occurredAt:1,lines:1}).sort({occurredAt:1}).toArray():Promise.resolve([]),
  ]);
  const identities = new Map(identityRows.map(product => [String(product.id), product])),parentDates=new Map(parentRows.map(document=>[String(document.id),String(document.occurredAt)])),purchaseHistory=new Map<string,Array<{at:string;unit:number}>>();
  for(const purchase of purchaseRows)for(const purchaseLine of (purchase.lines??[]) as Document[]){const key=String(purchaseLine.productId);if(!productIds.includes(key)||!Number.isFinite(Number(purchaseLine.unitPrice)))continue;const rows=purchaseHistory.get(key)??[];rows.push({at:String(purchase.occurredAt),unit:n(purchaseLine.unitPrice)});purchaseHistory.set(key,rows)}
  for (const document of documents) for (const line of (document.lines ?? []) as Document[]) {
    if (!lineMatches(line, f)) continue;
    const sign = document.kind === "return" ? -1 : 1;
    // Legacy read-only adjustments normally carry the original line cost. Records that do
    // not carry it must resolve at the original sale date, never the return date.
    const costDate=document.kind==="return"&&document.parentDocumentId?parentDates.get(String(document.parentDocumentId))??String(document.occurredAt):String(document.occurredAt);
    const historical=[...(purchaseHistory.get(String(line.productId))??[])].reverse().find(row=>row.at<=costDate);
    const cost:Cost=line.costAtSale!==null&&line.costAtSale!==undefined&&Number.isFinite(Number(line.costAtSale))?{unit:n(line.costAtSale),source:"snapshot"}:historical?{unit:historical.unit,source:"historical-purchase"}:{unit:null,source:"unknown"};
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
  const products = await db.collection("products").find({ expiryDate: { $type: "string", $lt: today }, isArchived: { $ne: true } }).toArray();
  return products.reduce((total, product) => {
    if (!isProductExpired(product, today)) return total;
    const remaining = Object.values((product.stocks ?? {}) as Record<string, number>).reduce((sum, quantity) => sum + Math.max(0, n(quantity)), 0);
    const cost = Number.isFinite(product.lastPurchaseCost) ? n(product.lastPurchaseCost) : Number.isFinite(product.pieceCost) ? n(product.pieceCost) : 0;
    return total + remaining * cost;
  }, 0);
}

async function directDocuments(db: Db, f: ReportFilters, kind: string) {
  const query: Document = { kind, status: "posted", ...matchDate(f) };
  if (f.paymentAccountId) query.paymentMethod = f.paymentAccountId;
  if (f.productId) query["lines.productId"] = f.productId;
  if (kind === "expense" && f.expenseType) query.recurringId = f.expenseType === "recurring" ? { $exists: true } : { $exists: false };
  const totalRows = await db.collection("documents").countDocuments(query);
  const rows = await pageCursor(db.collection("documents").find(query).sort({ occurredAt: -1 }), f).toArray();
  const all = f.unpaged ? rows : await db.collection("documents").find(query).toArray();
  return { rows, all, totalRows };
}

export async function buildReport(db: Db, f: ReportFilters): Promise<ReportResponse> {
  const expiryLoss = ["stock", "profit", "overview"].includes(f.type) ? await expiredInventoryLoss(db) : 0;
  if (f.type === "sales") {
    const sales = await directDocuments(db, f, "sale");
    // Read-only compatibility: fold persisted adjustments into net sales; never expose a KPI.
    const returnQuery = { kind: "return", status: "posted", ...matchDate(f), ...(f.productId ? { "lines.productId": f.productId } : {}) };
    const legacySaleAdjustments = await db.collection("documents").find(returnQuery).toArray();
    const summaryFacts = await saleFacts(db, [...sales.all, ...legacySaleAdjustments], f), totals = profitSummary(summaryFacts),pageIds=new Set(sales.rows.map(document=>String(document.id))),pageFacts=summaryFacts.filter(fact=>pageIds.has(String(fact.documentId)));
    const rows = f.productId ? pageFacts : sales.rows.map(document => { const p = profitSummary(pageFacts.filter(fact=>String(fact.documentId)===String(document.id))); return { id: String(document.id), documentId: String(document.id), number: displayDocumentNumber(document), occurredAt: String(document.occurredAt), party: String(document.partyName ?? "بيع مباشر"), paymentMethod: String(document.paymentMethod ?? ""), total: n(document.total), cost: p.cost, profit: p.profit, margin: n(document.total) ? p.profit / n(document.total) * 100 : 0, paid: n(document.paidTotal), due: n(document.dueTotal) }; });
    return { report: f.type, from: f.from!, to: f.to!, summary: { count: sales.totalRows, grossSales: sales.all.reduce((s, d) => s + (f.productId ? (d.lines as Document[]).filter(l => lineMatches(l, f)).reduce((x,l)=>x+n(l.lineTotal),0) : n(d.total)), 0), netSales: totals.revenue, cost: totals.cost, profit: totals.profit, margin: totals.margin, unknownRevenue: totals.unknownRevenue, paid: sales.all.reduce((s,d)=>s+n(d.paidTotal),0), due: sales.all.reduce((s,d)=>s+n(d.dueTotal),0) }, rows, meta: pagination(sales.totalRows, f) };
  }
  if (f.type === "purchases" || f.type === "expenses") {
    const kind = f.type === "purchases" ? "purchase" : "expense", found = await directDocuments(db, f, kind);
    const productIds = [...new Set(found.rows.flatMap(document => ((document.lines ?? []) as Document[]).map(line => String(line.productId ?? "")).filter(Boolean)))];
    const identities = new Map((await db.collection("products").find({ id: { $in: productIds } }).project({ id: 1, name: 1, sku: 1 }).toArray()).map(product => [String(product.id), product]));
    const rows = found.rows.map(document => { const selected = ((document.lines ?? []) as Document[]).filter(line => lineMatches(line, f)); if (f.type === "purchases" && f.productId) { const line=selected[0]; return { id:String(document.id),documentId:String(document.id),number:displayDocumentNumber(document),occurredAt:String(document.occurredAt),party:String(document.partyName??""),product:String(identities.get(String(line?.productId))?.name??line?.description??"").trim()||"منتج غير متاح",sku:String(identities.get(String(line?.productId))?.sku??line?.sku??"—")||"—",quantity:n(line?.quantity),unitPrice:n(line?.unitPrice),total:n(line?.lineTotal) }; } return { id:String(document.id),documentId:String(document.id),number:displayDocumentNumber(document),occurredAt:String(document.occurredAt),party:String(document.partyName??""),paymentMethod:String(document.paymentMethod??""),title:String(document.title??""),recurring:Boolean(document.recurringId),total:n(document.total),paid:n(document.paidTotal),due:n(document.dueTotal) }; });
    const value = (d: Document) => f.productId ? (d.lines as Document[]).filter(l=>lineMatches(l,f)).reduce((s,l)=>s+n(l.lineTotal),0) : n(d.total);
    return { report:f.type,from:f.from!,to:f.to!,summary:{count:found.totalRows,total:found.all.reduce((s,d)=>s+value(d),0),quantity:found.all.reduce((s,d)=>s+(d.lines as Document[]).filter(l=>lineMatches(l,f)).reduce((x,l)=>x+n(l.quantity),0),0),paid:found.all.reduce((s,d)=>s+n(d.paidTotal),0),due:found.all.reduce((s,d)=>s+n(d.dueTotal),0),recurringTotal:found.all.filter(d=>Boolean(d.recurringId)).reduce((s,d)=>s+n(d.total),0),oneOffTotal:found.all.filter(d=>!d.recurringId).reduce((s,d)=>s+n(d.total),0)},rows,meta:pagination(found.totalRows,f) };
  }
  if (f.type === "stock" || f.type === "financial") {
    const collection = f.type === "stock" ? "stockMovements" : "financialMovements", query: Document = matchDate(f);
    if (f.productId && f.type === "stock") query.productId=f.productId; if(f.movementType)query.type=f.movementType;if(f.paymentAccountId&&f.type==="financial")query.paymentMethod=f.paymentAccountId;if(f.direction&&f.type==="financial")query.direction=f.direction;
    const totalRows=await db.collection(collection).countDocuments(query), all=await db.collection(collection).find(query).toArray(), raw=f.unpaged?[...all].sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))):await pageCursor(db.collection(collection).find(query).sort({occurredAt:-1}),f).toArray();
    let rows: ReportRow[];
    if(f.type==="stock"){const products=await db.collection("products").find({id:{$in:raw.map(x=>x.productId)}}).project({id:1,sku:1,name:1}).toArray(),identities=new Map(products.map(p=>[String(p.id),p]));rows=raw.map(x=>({id:String(x.id),documentId:String(x.documentId),occurredAt:String(x.occurredAt),sku:String(identities.get(String(x.productId))?.sku??x.sku??"—")||"—",product:String(identities.get(String(x.productId))?.name??x.productName??"").trim()||"منتج غير متاح",warehouse:String(x.warehouseName),movementType:String(x.type),before:n(x.balanceBefore),change:n(x.quantityDelta),after:n(x.balanceAfter),documentNumber:String(x.documentNumber)}));return{report:f.type,from:f.from!,to:f.to!,summary:{movements:totalRows,expiredInventoryLoss:expiryLoss,incoming:all.reduce((s,x)=>s+Math.max(0,n(x.quantityDelta)),0),outgoing:all.reduce((s,x)=>s+Math.abs(Math.min(0,n(x.quantityDelta))),0),netChange:all.reduce((s,x)=>s+n(x.quantityDelta),0)},rows,meta:pagination(totalRows,f)};}
    rows=raw.map(x=>({id:String(x.id),documentId:String(x.documentId),occurredAt:String(x.occurredAt),paymentMethod:String(x.paymentMethod),movementType:String(x.type),incoming:x.direction==="in"?n(x.amount):0,outgoing:x.direction==="out"?n(x.amount):0,party:String(x.partyName??""),documentNumber:String(x.documentNumber??"")}));const operating=all.filter(x=>isOperatingFinancialMovement(x.type)),businessIncoming=operating.filter(x=>x.direction==="in").reduce((s,x)=>s+n(x.amount),0),businessOutgoing=operating.filter(x=>x.direction==="out").reduce((s,x)=>s+n(x.amount),0),balanceNet=all.reduce((s,x)=>s+(x.direction==="in"?n(x.amount):-n(x.amount)),0);return{report:f.type,from:f.from!,to:f.to!,summary:{incoming:all.filter(x=>x.direction==="in").reduce((s,x)=>s+n(x.amount),0),outgoing:all.filter(x=>x.direction==="out").reduce((s,x)=>s+n(x.amount),0),net:balanceNet,businessIncoming,businessOutgoing,businessNet:businessIncoming-businessOutgoing,balanceNet,operatingIncoming:businessIncoming,operatingOutgoing:businessOutgoing,operatingNet:businessIncoming-businessOutgoing},rows,meta:pagination(totalRows,f)};
  }
  if (f.type === "debts") { const query:Document={};if(f.search)query.$or=[{name:{$regex:f.search,$options:"i"}},{phone:{$regex:f.search}}];if(f.debtSide==="receivable")query.receivable={$gt:0};if(f.debtSide==="payable")query.payable={$gt:0};if(f.debtSide==="clear")query.$and=[{receivable:{$lte:0}},{payable:{$lte:0}}];const total=await db.collection("parties").countDocuments(query),all=await db.collection("parties").find(query).toArray(),raw=await pageCursor(db.collection("parties").find(query).sort({name:1}),f).toArray(),rows=raw.map(p=>({id:String(p.id),partyId:String(p.id),name:String(p.name),phone:String(p.phone??""),partyType:String(p.partyType),accountType:p.partyType==="customer"?"عميل":"مورد",balance:Math.abs(n(p.receivable)-n(p.payable)),receivable:Math.max(n(p.receivable)-n(p.payable),0),payable:Math.max(n(p.payable)-n(p.receivable),0),lastMovement:String(p.lastMovementAt??"")}));return{report:f.type,from:null,to:null,summary:{receivable:all.reduce((s,p)=>s+Math.max(n(p.receivable)-n(p.payable),0),0),payable:all.reduce((s,p)=>s+Math.max(n(p.payable)-n(p.receivable),0),0),net:all.reduce((s,p)=>s+n(p.receivable)-n(p.payable),0),count:total},rows,meta:pagination(total,f)}; }
  if (f.type === "party-ledger") {
    if (!f.partyId) throw new Error("يجب اختيار الطرف");
    const party = await db.collection("parties").findOne({ id: f.partyId });
    if (!party) throw new Error("الطرف غير موجود");
    const partyType = resolvePartyType(party), query = { partyId: f.partyId, status: "posted", kind: { $in: ["sale", "purchase", "return", "payment", "offset", "settlement"] }, ...matchDate(f) };
    const [total, all, raw] = await Promise.all([
      db.collection("documents").countDocuments(query),
      db.collection("documents").find(query).toArray(),
      pageCursor(db.collection("documents").find(query).sort({ occurredAt: -1 }), f).toArray(),
    ]);
    const parentIds = all.filter(d => d.kind === "return" && d.parentDocumentId).map(d => d.parentDocumentId);
    const parentKinds = new Map((await db.collection("documents").find({ id: { $in: parentIds } }).project({ id: 1, kind: 1 }).toArray()).map(d => [String(d.id), String(d.kind)]));
    const effect = (d: Document) => {
      if (Number.isFinite(Number(d.partyBalanceDelta))) return n(d.partyBalanceDelta);
      if (d.kind === "sale") return n(d.dueTotal);
      if (d.kind === "purchase") return -n(d.dueTotal);
      if (d.kind === "return") return -Math.max(0, n(d.total) - n(d.paidTotal));
      if (d.kind === "offset") return 0;
      if (d.kind === "payment" && d.partyCashDirection) return d.partyCashDirection === "receive" ? -n(d.total) : n(d.total);
      // Compatibility only: pre-PR #69 payments have no structured party metadata.
      if (d.kind === "payment" || d.kind === "settlement") return String(d.title).includes("دفع لنا") ? -n(d.total) : n(d.total);
      return 0;
    };
    const role = partyType === "customer" ? "العميل" : "المورد";
    const movementLabel = (d: Document) => d.kind === "sale" ? "فاتورة بيع" : d.kind === "purchase" ? "فاتورة شراء" : d.kind === "return" ? "حركة تاريخية" : d.kind === "offset" ? "مقاصة" : d.kind === "settlement" ? "تسوية" : d.partyCashDirection === "receive" ? `استلام من ${role}` : d.partyCashDirection === "pay" ? (partyType === "customer" ? "دفع للعميل" : "دفع للمورد") : "دفعة";
    const rows = raw.map(d => { const delta = effect(d); return { id: String(d.id), documentId: String(d.id), occurredAt: String(d.occurredAt), movementType: movementLabel(d), documentNumber: displayDocumentNumber(d), description: String(d.title ?? d.partyName ?? ""), debit: Math.max(delta, 0), credit: Math.max(-delta, 0), paymentMethod: String(d.paymentMethod ?? "") }; });
    const tradeTotal = partyType === "customer"
      ? all.reduce((sum, d) => sum + (d.kind === "sale" ? n(d.total) : d.kind === "return" && parentKinds.get(String(d.parentDocumentId)) !== "purchase" ? -n(d.total) : 0), 0)
      : all.reduce((sum, d) => sum + (d.kind === "purchase" ? n(d.total) : d.kind === "return" && parentKinds.get(String(d.parentDocumentId)) === "purchase" ? -n(d.total) : 0), 0);
    const net = n(party.receivable) - n(party.payable), debitTotal=all.reduce((sum,d)=>sum+Math.max(effect(d),0),0), creditTotal=all.reduce((sum,d)=>sum+Math.max(-effect(d),0),0);
    return { report: f.type, from: f.from ?? null, to: f.to ?? null, summary: { name: String(party.name), partyType, tradeTotal, debitTotal, creditTotal, receivable: Math.max(net, 0), payable: Math.max(-net, 0), net, transactionCount: total }, rows, meta: pagination(total, f) };
  }
  // Read-only compatibility: legacy adjustments remain negative sale facts.
  const documents=await db.collection("documents").find({kind:{$in:["sale","return"]},status:"posted",...matchDate(f),...(f.productId?{"lines.productId":f.productId}:{})}).toArray(),facts=await saleFacts(db,documents,f);
  if(f.type==="product-sales"){
    const purchases=await db.collection("documents").find({kind:"purchase",status:"posted",...matchDate(f),...(f.productId?{"lines.productId":f.productId}:{})}).project({lines:1}).toArray();
    const activeWarehouses=new Set((await db.collection("warehouses").find({isArchived:{$ne:true}}).project({_id:1}).toArray()).map(warehouse=>String(warehouse._id)));
    const productQuery:Document={...(f.productId?{id:f.productId}:{})};
    const productRows=await db.collection("products").find(productQuery).project({id:1,sku:1,name:1,stocks:1}).toArray(),map=new Map<string,ReportRow>();
    for(const product of productRows)map.set(String(product.id),{id:String(product.id),productId:String(product.id),sku:String(product.sku??"—")||"—",product:String(product.name??"").trim()||"منتج غير متاح",soldQuantity:0,currentQuantity:Object.entries((product.stocks??{}) as Record<string,unknown>).filter(([warehouseId])=>activeWarehouses.has(warehouseId)).reduce((sum,[,quantity])=>sum+n(quantity),0),netSales:0,purchasedQuantity:0,purchases:0,netPurchases:0,averagePrice:0,averagePurchasePrice:0,profit:0,costKnown:true});
    for(const fact of facts){const key=String(fact.productId),row=map.get(key);if(!row)continue;row.soldQuantity=n(row.soldQuantity)+n(fact.quantity);row.netSales=n(row.netSales)+n(fact.revenue);row.averagePrice=n(row.soldQuantity)?n(row.netSales)/n(row.soldQuantity):0;row.costKnown=Boolean(row.costKnown)&&Boolean(fact.costKnown);row.profit=n(row.profit)+n(fact.profit)}
    for(const purchase of purchases)for(const line of (purchase.lines??[]) as Document[]){const row=map.get(String(line.productId));if(!row)continue;row.purchasedQuantity=n(row.purchasedQuantity)+n(line.quantity);row.purchases=n(row.purchases)+n(line.lineTotal);row.netPurchases=n(row.purchases);row.averagePurchasePrice=n(row.purchasedQuantity)?n(row.purchases)/n(row.purchasedQuantity):0}
    const rows=[...map.values()];return{report:f.type,from:f.from!,to:f.to!,summary:{products:rows.length,quantity:rows.reduce((sum,row)=>sum+n(row.currentQuantity),0),sales:rows.reduce((sum,row)=>sum+n(row.netSales),0),purchases:rows.reduce((sum,row)=>sum+n(row.netPurchases),0),profit:rows.reduce((sum,row)=>sum+n(row.profit),0),unknownRevenue:facts.reduce((sum,row)=>sum+n(row.unknownRevenue),0)},rows:slice(rows,f),meta:pagination(rows.length,f)};
  }
  const grouped=new Map<string,ReportRow>();for(const fact of facts){const key=f.groupBy==="product"?String(fact.productId):String(fact.documentId),g=grouped.get(key)??{id:key,documentId:fact.documentId,number:fact.number,occurredAt:fact.occurredAt,productId:fact.productId,product:fact.product,sku:fact.sku,quantity:0,revenue:0,cost:0,profit:0,unknownRevenue:0,costKnown:true,invoiceIdList:""};g.quantity=n(g.quantity)+n(fact.quantity);g.revenue=n(g.revenue)+n(fact.revenue);g.cost=n(g.cost)+n(fact.cost);g.profit=n(g.profit)+n(fact.profit);g.unknownRevenue=n(g.unknownRevenue)+n(fact.unknownRevenue);g.costKnown=Boolean(g.costKnown)&&Boolean(fact.costKnown);const ids=new Set(String(g.invoiceIdList).split(",").filter(Boolean));ids.add(String(fact.documentId));g.invoiceIdList=[...ids].join(",");g.invoiceCount=ids.size;g.margin=n(g.revenue)?n(g.profit)/n(g.revenue)*100:0;grouped.set(key,g)}const prows=[...grouped.values()].map(row=>{const copy={...row};delete copy.invoiceIdList;return copy}).sort((a,b)=>n(b.profit)-n(a.profit));if(f.type==="profit")return{report:f.type,from:f.from!,to:f.to!,summary:{...profitSummary(facts),expiredInventoryLoss:expiryLoss},rows:slice(prows,f),meta:pagination(prows.length,f)};
  // Overview totals include legacy effects, while the invoice list below hides that retired kind.
  const commercial=await db.collection("documents").find({kind:{$in:["sale","return","purchase","expense"]},status:"posted",...matchDate(f)}).toArray();
  // These collections are intentionally unfiltered by the report period: the lower
  // overview is a current position snapshot, while `commercial` remains period-bound.
  const [parties,accounts,products,warehouses]=await Promise.all([
    db.collection("parties").find().sort({name:1}).toArray(),
    db.collection("paymentAccounts").find({isActive:{$ne:false},isArchived:{$ne:true}}).sort({createdAt:1,name:1}).toArray(),
    // Archived products remain here because their on-hand stock still has value.
    db.collection("products").find().project({stocks:1,lastPurchaseCost:1,pieceCost:1}).toArray(),
    db.collection("warehouses").find().sort({createdAt:1,name:1}).toArray(),
  ]);
  const factsByDocument=new Map<string,{cost:number;profit:number}>();for(const fact of facts){const key=String(fact.documentId),current=factsByDocument.get(key)??{cost:0,profit:0};current.cost+=n(fact.cost);current.profit+=n(fact.profit);factsByDocument.set(key,current)}
  const kindRank:Record<string,number>={sale:0,purchase:1,expense:2};
  const invoices=commercial.filter(d=>d.kind!=="return").map(d=>{const kind=String(d.kind) as "sale"|"purchase"|"expense",value=n(d.total),saleFact=factsByDocument.get(String(d.id));return{id:String(d.id),documentId:String(d.id),kind,type:kind==="sale"?"فاتورة بيع":kind==="purchase"?"فاتورة شراء":"فاتورة مصروفات",number:displayDocumentNumber(d),sequence:Number.isSafeInteger(Number(d.sequence))&&n(d.sequence)>0?n(d.sequence):null,occurredAt:String(d.occurredAt),invoiceValue:value,cost:kind==="sale"?(saleFact?.cost??0):value,profit:kind==="sale"?(saleFact?.profit??value):null}}).sort((a,b)=>kindRank[a.kind]-kindRank[b.kind]||((a.sequence??Number.MAX_SAFE_INTEGER)-(b.sequence??Number.MAX_SAFE_INTEGER))||a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
  const typedParties=parties.map(p=>({...p,partyType:resolvePartyType(p)} as Document & {partyType:"customer"|"supplier"}));
  const partyRows=typedParties.map(p=>({id:String(p.id),partyId:String(p.id),name:String(p.name),partyType:p.partyType,receivable:Math.max(n(p.receivable)-n(p.payable),0),payable:Math.max(n(p.payable)-n(p.receivable),0)}));
  const bankAccounts=accounts.map(a=>({id:String(a.id??a._id),name:String(a.name),balance:n(a.balance)}));
  const currentAccountsBalance=bankAccounts.reduce((v,a)=>v+a.balance,0);
  const warehouseValues=warehouses.map(warehouse=>{
    const id=String(warehouse.id??warehouse._id);
    const value=products.reduce((sum,product)=>sum+n(product.stocks?.[id])*inventoryUnitCost({lastPurchaseCost:Number.isFinite(product.lastPurchaseCost)?n(product.lastPurchaseCost):null,pieceCost:Number.isFinite(product.pieceCost)?n(product.pieceCost):null}),0);
    return {id,name:String(warehouse.name),value,archived:warehouse.isArchived===true};
  }).filter(warehouse=>!warehouse.archived||warehouse.value!==0);
  const currentInventoryValue=warehouseValues.reduce((sum,warehouse)=>sum+warehouse.value,0);
  const currentReceivable=typedParties.reduce((v,p)=>v+Math.max(n(p.receivable)-n(p.payable),0),0);
  const currentPayable=typedParties.reduce((v,p)=>v+Math.max(n(p.payable)-n(p.receivable),0),0);
  const p=profitSummary(facts),sales=commercial.filter(d=>d.kind==="sale").reduce((v,d)=>v+n(d.total),0)-commercial.filter(d=>d.kind==="return").reduce((v,d)=>v+n(d.total),0),expenses=commercial.filter(d=>d.kind==="expense").reduce((v,d)=>v+n(d.total),0);
  return{report:"overview",from:f.from!,to:f.to!,summary:{sales,salesCost:p.cost,salesProfit:p.profit,purchases:commercial.filter(d=>d.kind==="purchase").reduce((v,d)=>v+n(d.total),0),expenses,netOperatingResult:p.profit-expenses,profit:p.profit,currentReceivable,currentPayable,currentInventoryValue,currentAccountsBalance,customerReceivables:currentReceivable,supplierPayables:currentPayable,bankBalance:currentAccountsBalance,inventoryValue:currentInventoryValue,customerCount:typedParties.filter(p=>p.partyType==="customer").length,supplierCount:typedParties.filter(p=>p.partyType==="supplier").length},rows:[],invoices,parties:partyRows,bankAccounts,warehouseValues,meta:pagination(invoices.length,f)};

}
