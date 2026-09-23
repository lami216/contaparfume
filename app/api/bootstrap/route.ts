import { requireValidLicense } from "../../../lib/license.ts";
import { getDatabase } from "../../../lib/sqlite";
import { resolvePartyType } from "../../domain";
import { log } from "../../../lib/log";
import { getPrincipalFromRequest, hasCapability, type Capability } from "../../../lib/auth";
import { peekNextDocumentSequence } from "../../../lib/document-sequences";
import { calculatePartyFinancialSummaries } from "../../party-metrics";
import { productsWithCurrentCosts } from "../../../lib/product-cost.ts";
import { getInvoiceBranding } from "../../../lib/invoice-branding";
import { classifyStockMovementType } from "../../stock-movement";
import { canReadOperationalDocument, isEffectiveFinancialMovement, resolveCurrentPartyName } from "../../../lib/document-read-model";

export async function GET(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
  const principal=await getPrincipalFromRequest(request);if(!principal)return Response.json({error:"غير مصرح"},{status:401});
  try {
    const db = await getDatabase();

    const [parties, warehouses, products, categories, documents, movements, financialMovements, paymentAccounts, accountTransfers, productCounter, nextSale, nextPurchase, nextExpense, nextDecantSale, nextDecantPurchase, branding] = await Promise.all([
      db.collection("parties").find().sort({ name: 1 }).toArray(), db.collection("warehouses").find().sort({ isSalesDefault: -1, name: 1 }).toArray(),
      db.collection("products").find().sort({ name: 1 }).toArray(), db.collection("productCategories").find().sort({ name: 1 }).toArray(), db.collection("documents").find().sort({ occurredAt: -1 }).toArray(),
      db.collection("stockMovements").find().sort({ occurredAt: -1 }).toArray(),
      db.collection("financialMovements").find().sort({ occurredAt: -1 }).toArray(),
      db.collection("paymentAccounts").find().sort({ createdAt: 1 }).toArray(),
      db.collection("accountTransfers").find().sort({ occurredAt: -1 }).toArray(),
      db.collection<{ _id: string; value: number }>("counters").findOne({ _id: "productSequence" }),
      peekNextDocumentSequence(db, "sale"), peekNextDocumentSequence(db, "purchase"), peekNextDocumentSequence(db, "expense"), peekNextDocumentSequence(db, "decant-sale"), peekNextDocumentSequence(db, "decant-purchase"), getInvoiceBranding(db),
    ]);
    const clean = (rows: Array<Record<string, unknown>>) => rows.map(({ _id, ...row }) => ({ id: row.id ?? String(_id), ...row }));
    const postedCostDocuments=documents.filter(document=>document.status==="posted"&&["purchase","decant-purchase","adjustment"].includes(String(document.kind)));
    const cleanProducts = clean(await productsWithCurrentCosts(db, products, postedCostDocuments)).map(product => ({ ...product, wholesalePrice: (product as Record<string, unknown>).wholesalePrice ?? null, expiryDate: (product as Record<string, unknown>).expiryDate ?? null, note: (product as Record<string, unknown>).note ?? null, categoryId: (product as Record<string, unknown>).categoryId ?? null }));
    const cleanCategories = clean(categories).map(category => { const item = category as Record<string, unknown>; return { id: String(item.id ?? ""), name: String(item.name ?? "") }; }).filter(category => category.id && category.name);
    const documentHints = new Map(documents.map(document => [String(document.id ?? document._id ?? ""), document]));
    const cleanMovements = clean(movements as Array<Record<string, unknown>>).map((movement: Record<string, unknown>) => ({ ...movement, type: classifyStockMovementType(movement.type, documentHints.get(String(movement.documentId ?? ""))) }));
    const effectiveFinancialMovements=(financialMovements as Array<Record<string,unknown>>).filter(isEffectiveFinancialMovement);
    const partyMetricDocuments=(documents as Array<Record<string,unknown>>).filter(document=>["sale","decant-sale","return","purchase","decant-purchase"].includes(String(document.kind)));
    const effectivePartyMetricMovements=effectiveFinancialMovements.filter(movement=>typeof movement.partyId==="string");
    const nonOperatingTypes=new Set(["opening-balance","opening-balance-correction"]);
    const totalByAccount=new Map<string,{_id:string;income:number;expenses:number;purchaseTotal:number;derivedOpening:number}>();
    for(const movement of effectiveFinancialMovements){const key=String(movement.paymentMethod),row=totalByAccount.get(key)??{_id:key,income:0,expenses:0,purchaseTotal:0,derivedOpening:0},amount=Number(movement.amount??0),signed=Number.isFinite(Number(movement.delta))?Number(movement.delta):(movement.direction==="out"?-amount:amount);if(movement.type==="opening-balance"||movement.type==="opening-balance-correction")row.derivedOpening+=signed;if(movement.direction==="in"&&!nonOperatingTypes.has(String(movement.type)))row.income+=amount;if(movement.direction==="out"&&!nonOperatingTypes.has(String(movement.type)))row.expenses+=amount;if(movement.type==="purchase"||movement.type==="decant-purchase")row.purchaseTotal+=amount;totalByAccount.set(key,row)}
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
    const cleanParties = clean(parties).map(party => ({ ...party, partyType: resolvePartyType(party) })) as Array<Record<string, unknown> & { partyType: ReturnType<typeof resolvePartyType> }>;
    const bankAccess=hasCapability(principal,"banks.view")||hasCapability(principal,"banks.movements.view"),partyAdmin=hasCapability(principal,"customers.view")||hasCapability(principal,"suppliers.view"),productAdmin=hasCapability(principal,"products.view"),perfumeAccess=hasCapability(principal,"perfume.divisions.view"),inventoryCostAccess=productAdmin||perfumeAccess||hasCapability(principal,"warehouses.inventory.view");
    // Keep archived accounts exposed for historical name resolution; selectors filter them centrally.
    const selectorAccounts=(clean(accountRows) as Array<Record<string,unknown>>).map(account=>bankAccess?account:{id:account.id,code:account.code,name:account.name,isActive:account.isActive,isArchived:account.isArchived,allowNegativeBalance:false});
    const customerPartyIds=new Set(cleanParties.filter(party=>resolvePartyType(party)==="customer").map(party=>String(party.id)));
    const supplierPartyIds=new Set(cleanParties.filter(party=>resolvePartyType(party)==="supplier").map(party=>String(party.id)));
    const currentPartyNames=new Map(cleanParties.map(party=>[String(party.id),String(party.name??"")] as const));
    const readAccess={can:(capability:string)=>hasCapability(principal,capability as Capability),customerPartyIds,supplierPartyIds};
    const allowedDocuments=(clean(documents) as Array<Record<string,unknown>>).filter(document=>canReadOperationalDocument(document,readAccess)||(perfumeAccess&&["decant-sale","decant-purchase"].includes(String(document.kind)))).map(document=>resolveCurrentPartyName(document,currentPartyNames));
    const exposedParties=(cleanParties as Array<Record<string,unknown>>).map(party=>hasCapability(principal,resolvePartyType(party)==="supplier"?"suppliers.view":"customers.view")?party:{id:party.id,name:party.name,phone:party.phone,partyType:party.partyType,isArchived:party.isArchived,receivable:0,payable:0,net:0});
    const exposedProducts=inventoryCostAccess?cleanProducts:(cleanProducts as Array<Record<string,unknown>>).map(({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,categoryId,stocks,isArchived})=>({id,name,sku,barcode,piecePrice,wholesalePrice,expiryDate,categoryId,stocks,isArchived,pieceCost:null,lastPurchaseCost:null}));
    const visiblePartyIds=new Set(cleanParties.filter(party=>(resolvePartyType(party)==="customer"&&hasCapability(principal,"customers.view"))||(resolvePartyType(party)==="supplier"&&hasCapability(principal,"suppliers.view"))).map(party=>String(party.id)));
    const partyFinancialSummaries=partyAdmin?calculatePartyFinancialSummaries(partyMetricDocuments as never[],effectivePartyMetricMovements as never[]).filter(summary=>visiblePartyIds.has(summary.partyId)):[];
    const effectiveTransfers=(accountTransfers as Array<Record<string,unknown>>).filter(transfer=>transfer.status!=="voided");
    return Response.json({ branding, principal:{principalType:principal.principalType,name:principal.name,permissions:principal.permissions}, parties:exposedParties, warehouses:clean(warehouses), products:exposedProducts, categories:cleanCategories, documents:allowedDocuments, movements:hasCapability(principal,"warehouses.inventory.view")?cleanMovements:[], financialMovements:bankAccess?clean(effectiveFinancialMovements):[], partyFinancialSummaries, paymentAccounts:selectorAccounts, accountTransfers:bankAccess?clean(effectiveTransfers):[], nextProductCode, nextDocumentSequences:{sale:nextSale,purchase:nextPurchase,expense:nextExpense,decantSale:nextDecantSale,decantPurchase:nextDecantPurchase} });
  } catch (error) { log("error", "api.bootstrap.failed", { error }); return Response.json({ error: "تعذر تحميل البيانات" }, { status: 500 }); }
}
