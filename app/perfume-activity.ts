import { managementKind, documentUsesPerfumeLot } from "./perfume-management.ts";
type Row=Record<string,unknown>;
const rows=(value:unknown):Row[]=>Array.isArray(value)?value:[];
export type PerfumeContext={productId:string;lotId?:string;conversionId?:string;name?:string};
export const isPerfumeCatalogDocument=(document:Row)=>managementKind(document)==="bottle";
export function isPerfumeBusinessDocument(document:Row,products:Row[]){
  if(isPerfumeCatalogDocument(document))return false;
  if(managementKind(document)||["decant-sale","decant-purchase"].includes(String(document.kind))||document.perfumeStockOperationType==="unit-conversion")return true;
  const ids=new Set(products.filter(p=>["decant","partial","bottle"].includes(String(p.perfumeForm))).map(p=>p.id));
  return rows(document.lines).some(line=>ids.has(line.productId)||ids.has(line.bottleProductId));
}
/** Resolves source documents, lot allocations and returned partial descendants without creating another ledger. */
export function relatedPerfumeDocuments<T>(documents:T[],context:PerfumeContext):T[]{
  const all=documents as Row[],partials=new Set<unknown>();
  for(const d of all)if(d.perfumeLotId===context.lotId&&context.lotId){
    if(d.partialProductId)partials.add(d.partialProductId);
    if(d.perfumeConversionType==="perfume-recombine")for(const line of rows(d.lines))if(Number(line.quantity)>0&&line.productId!==context.productId)partials.add(line.productId);
  }
  const matched=documents.filter(item=>{
    const d=item as Row;if(isPerfumeCatalogDocument(d))return false;
    if(!context.lotId)return d.managementProductId===context.productId||d.bottleProductId===context.productId||rows(d.lines).some(l=>l.productId===context.productId||l.bottleProductId===context.productId);
    return d.id===context.conversionId||d.perfumeLotId===context.lotId||documentUsesPerfumeLot(d,context.productId,context.lotId)||rows(d.lines).some(l=>partials.has(l.productId));
  });
  const key=(d:Row)=>d.id??d._id;
  const ids=new Set((matched as Row[]).map(key).filter(Boolean));
  // A source edit may replace both the generated product and lot identities.
  // Follow document revisions so their original snapshots remain reachable.
  let changed=true;
  while(changed){changed=false;for(const d of all)if(key(d)&&!isPerfumeCatalogDocument(d)&&!ids.has(key(d))&&d.replacedByDocumentId&&ids.has(d.replacedByDocumentId)){ids.add(key(d));changed=true}}
  return documents.filter(item=>ids.has(key(item as Row)));
}
export function currentPerfumeOperations<T>(documents:T[],showVoided=false):T[]{
  const all=documents as Row[],ids=new Set(all.map(d=>d.id));
  return documents.filter(item=>{const d=item as Row;return !isPerfumeCatalogDocument(d)&&(!d.replacedByDocumentId||!ids.has(d.replacedByDocumentId))&&(showVoided||d.status==="posted")});
}
