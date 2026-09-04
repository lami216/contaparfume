import { requireValidLicense } from "../../../lib/license.ts";
import { getDatabase } from "../../../lib/sqlite";
import { resolvePartyType } from "../../domain";
import { log } from "../../../lib/log";
import { getPrincipalFromRequest, hasCapability } from "../../../lib/auth";
import { peekNextDocumentSequence } from "../../../lib/document-sequences";
import { calculatePartyFinancialSummaries } from "../../party-metrics";
import { getInvoiceBranding } from "../../../lib/invoice-branding";

export async function GET(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
  const principal=await getPrincipalFromRequest(request);if(!principal)return Response.json({error:"غير مصرح"},{status:401});
  try {
    const db = await getDatabase();

    // One-time, idempotent legacy backfill. The sorted unwind makes the first line
    // for each product the newest real posted purchase price.
    const legacyCosts = await db.collection("documents").aggregate([
      { $match: { kind: "purchase", status: "posted" } }, { $sort: { occurredAt: -1 } },
      { $unwind: "$lines" }, { $match: { "lines.productId": { $type: "string" } } },
      { $group: { _id: "$lines.productId", cost: { $first: "$lines.unitPrice" }, at: { $first: "$occurredAt" } } },
    ]).toArray();
    if (legacyCosts.length) await db.collection("products").bulkWrite(legacyCosts.map(cost => ({
      updateOne: { filter: { id: cost._id, lastPurchaseCost: { $exists: false } }, update: { $set: { lastPurchaseCost: cost.cost, lastPurchaseAt: cost.at } } },
    })));
    const [parties, warehouses, products, documents, movements, financialMovements, partyMetricDocuments, partyMetricMovements, paymentAccounts, accountTransfers, productCounter, nextSale, nextPurchase, nextExpense, branding] = await Promise.all([
      db.collection("parties").find().sort({ name: 1 }).toArray(), db.collection("warehouses").find().sort({ isSalesDefault: -1, name: 1 }).toArray(),
      db.collection("products").find().sort({ name: 1 }).toArray(), db.collection("documents").find().sort({ occurredAt: -1 }).limit(500).toArray(),
      db.collection("stockMovements").find().sort({ occurredAt: -1 }).limit(1000).toArray(),
      db.collection("financialMovements").find().sort({ occurredAt: -1 }).limit(2000).toArray(),
      // Legacy read-only adjustments remain in aggregate inputs; no creation surface exists.
      db.collection("documents").find({ kind: { $in: ["sale", "return", "purchase"] } }, { projection: { _id: 0, kind: 1, status: 1, partyId: 1, total: 1, lines: 1 } }).toArray(),
      db.collection("financialMovements").find({ partyId: { $type: "string" } }, { projection: { _id: 0, partyId: 1, direction: 1, amount: 1 } }).toArray(),
      db.collection("paymentAccounts").find().sort({ createdAt: 1 }).toArray(),
      db.collection("accountTransfers").find().sort({ occurredAt: -1 }).limit(500).toArray(),
      db.collection<{ _id: string; value: number }>("counters").findOne({ _id: "productSequence" }),
      peekNextDocumentSequence(db, "sale"), peekNextDocumentSequence(db, "purchase"), peekNextDocumentSequence(db, "expense"), getInvoiceBranding(db),
    ]);
    const clean = (rows: Array<Record<string, unknown>>) => rows.map(({ _id, ...row }) => ({ id: row.id ?? String(_id), ...row }));
    const cleanProducts = clean(products).map(product => ({ ...product, wholesalePrice: (product as Record<string, unknown>).wholesalePrice ?? null, expiryDate: (product as Record<string, unknown>).expiryDate ?? null, note: (product as Record<string, unknown>).note ?? null }));
    const nonOperatingTypes=new Set(["opening-balance","opening-balance-correction"]);
    const totalByAccount=new Map<string,{_id:string;income:number;expenses:number;purchaseTotal:number;derivedOpening:number}>();
    for(const movement of financialMovements){const key=String(movement.paymentMethod),row=totalByAccount.get(key)??{_id:key,income:0,expenses:0,purchaseTotal:0,derivedOpening:0},amount=Number(movement.amount??0),signed=Number.isFinite(Number(movement.delta))?Number(movement.delta):(movement.direction==="out"?-amount:amount);if(movement.type==="opening-balance"||movement.type==="opening-balance-correction")row.derivedOpening+=signed;if(movement.direction==="in"&&!nonOperatingTypes.has(String(movement.type)))row.income+=amount;if(movement.direction==="out"&&!nonOperatingTypes.has(String(movement.type)))row.expenses+=amount;if(movement.type==="purchase")row.purchaseTotal+=amount;totalByAccount.set(key,row)}
    const totals=[...totalByAccount.values()];
    const totalMap = new Map(totals.map(row => [String(row._id), row]));
    const accountRows = paymentAccounts.map(account => {
      const aggregate = totalMap.get(String(account.id)) ?? totalMap.get(String(account.code));
      const storedOpening=Number(account.openingBalance);
      return { ...account, id: String(account.id), balance: Number(account.balance ?? 0), openingBalance:Number.isFinite(storedOpening)?storedOpening:Number(aggregate?.derivedOpening??0), allowNegativeBalance: account.allowNegativeBalance === true, income: Number(aggregate?.income ?? 0), expenses: Number(aggregate?.expenses ?? 0), purchaseTotal: Number(aggregate?.purchaseTotal ?? 0) };
    });
    const highestLegacyCode = products.reduce((highest, product) => {
      const code = String(product.sku ?? "");
      return /^\d{1,6}$/.test(code) ? Math.max(highest, Number(code)) : highest;
    }, 0);
    const nextProductCode = Math.max(highestLegacyCode, Number(productCounter?.value ?? 0)) + 1;
    const cleanParties = clean(parties).map(party => ({ ...party, partyType: resolvePartyType(party) }));
    const bankAccess=hasCapability(principal,"banks.view")||hasCapability(principal,"banks.movements.view"),partyAdmin=hasCapability(principal,"customers.view")||hasCapability(principal,"suppliers.view"),productAdmin=hasCapability(principal,"products.view");
    // Keep archived accounts exposed for historical name resolution; selectors filter them centrally.
    const selectorAccounts=(clean(accountRows) as Array<Record<string,unknown>>).map(account=>bankAccess?account:{id:account.id,code:account.code,name:account.name,isActive:account.isActive,isArchived:account.isArchived,allowNegativeBalance:false});
    const allowedDocuments=(clean(documents) as Array<Record<string,unknown>>).filter(document=>hasCapability(principal,"records.view")||(hasCapability(principal,"pos.view")&&document.kind==="sale")||(hasCapability(principal,"purchases.view")&&document.kind==="purchase")||(hasCapability(principal,"expenses.view")&&document.kind==="expense"));
    const exposedParties=partyAdmin?cleanParties:(cleanParties as Array<Record<string,unknown>>).map(({id,name,phone,partyType})=>({id,name,phone,partyType,receivable:0,payable:0,net:0}));
    const exposedProducts=productAdmin?cleanProducts:(cleanProducts as Array<Record<string,unknown>>).map(({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,stocks,isArchived})=>({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,stocks,isArchived,pieceCost:null,lastPurchaseCost:null}));
    const visiblePartyIds=new Set(cleanParties.filter(party=>(resolvePartyType(party)==="customer"&&hasCapability(principal,"customers.view"))||(resolvePartyType(party)==="supplier"&&hasCapability(principal,"suppliers.view"))).map(party=>String(party.id)));
    const partyFinancialSummaries=partyAdmin?calculatePartyFinancialSummaries(partyMetricDocuments as never[],partyMetricMovements as never[]).filter(summary=>visiblePartyIds.has(summary.partyId)):[];
    return Response.json({ branding, principal:{principalType:principal.principalType,name:principal.name,permissions:principal.permissions}, parties:exposedParties, warehouses:clean(warehouses), products:exposedProducts, documents:allowedDocuments, movements:hasCapability(principal,"warehouses.inventory.view")?clean(movements):[], financialMovements:bankAccess?clean(financialMovements):[], partyFinancialSummaries, paymentAccounts:selectorAccounts, accountTransfers:hasCapability(principal,"banks.transfer")?clean(accountTransfers):[], nextProductCode, nextDocumentSequences:{sale:nextSale,purchase:nextPurchase,expense:nextExpense} });
  } catch (error) { log("error", "api.bootstrap.failed", { error }); return Response.json({ error: "تعذر تحميل البيانات" }, { status: 500 }); }
}
