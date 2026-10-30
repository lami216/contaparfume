import type {SqliteDatabase as Db, SqliteSession as Session} from "../lib/sqlite.ts";
import type {PerfumeLot} from "./perfume-logic.ts";
import {documentUsesPerfumeLot, managementKind} from "./perfume-management.ts";
import {roundMl} from "./perfume-volume.ts";

type Row=Record<string,unknown>;
export type PerfumeDependency={documentId:string;number:string;label:string;occurredAt:string};
const kinds:Record<string,string>={split:"تحويل عطر",recombine:"إرجاع الباقي",opening:"رصيد افتتاحي",consumption:"استهلاك", "yield-correction":"تسوية",sale:"فاتورة بيع","decant-sale":"فاتورة تقسيمات",transfer:"تحويل مخزني",adjustment:"تسوية مخزون"};
const dependency=(d:Row):PerfumeDependency=>({documentId:String(d.id),number:String(d.number??d.id),label:kinds[managementKind(d)??String(d.kind)]??"عملية",occurredAt:String(d.occurredAt??"")});
export function perfumeOperationBlocked(message:string,documents:Row[]=[]){
  const dependencies=[...new Map(documents.map(d=>[d.id,dependency(d)])).values()];
  const references=dependencies.map(d=>`${d.label} ${d.number}`).join("، ");
  return Object.assign(new Error(message+(references?` ${references}`:"")),{status:409,code:"PERFUME_OPERATION_BLOCKED",dependencies});
}
export function openSourceLots(products:Array<{id?:unknown;perfumeForm?:unknown;parentProductId?:unknown;perfumeLots?:unknown;stocks?:unknown;name?:unknown}>,sourceId:string,exceptLotId?:string){
  return products.filter(p=>p.perfumeForm==="decant"&&String(p.parentProductId)===sourceId).flatMap(p=>{
    const lots=(Array.isArray(p.perfumeLots)?p.perfumeLots:[]) as PerfumeLot[];
    const open=lots.filter(l=>l.id!==exceptLotId&&(Number(l.remainingQuantity)>0||Object.values(l.stocks??{}).some(q=>Number(q)>0)));
    if(!lots.length&&Object.values((p.stocks??{}) as Row).some(q=>Number(q)>0))return [{productId:String(p.id),lotId:"",quantity:Number(Object.values((p.stocks??{}) as Row).reduce<number>((s,q)=>s+Number(q),0)),documentId:"",name:String(p.name)}];
    return open.map(l=>({productId:String(p.id),lotId:l.id,quantity:Number(l.remainingQuantity),documentId:l.conversionDocumentId,name:l.sourceProductName}));
  });
}
export async function assertSourceCleared(db:Db,session:Session,sourceId:string){
  const products=await db.collection("products").find({parentProductId:sourceId,perfumeForm:"decant"},{session}).toArray();
  const open=openSourceLots(products,sourceId);
  if(!open.length)return;
  const documents=await db.collection("documents").find({id:{$in:open.map(l=>l.documentId)},status:"posted"},{session}).toArray();
  throw perfumeOperationBlocked(`لا يمكن فتح دفعة جديدة؛ ما زال للعطر رصيد تقسيمات في دفعة سابقة (${open.map(l=>l.quantity).join("، ")}). إذا نفد فعليًا، سوِّ المتبقي إلى صفر لتسجيل الفرق أولًا. الدفعة السابقة:`,documents);
}

/** Absolute counts/returns are barriers. Voided sales must never be barriers. */
export async function laterLotDocuments(db:Db,session:Session,d:Row){
  // SQLite's default row order is insertion order. Business dates can be edited
  // or backdated and therefore cannot establish the dependency order.
  const all=await db.collection("documents").find({},{session}).toArray(),anchor=all.findIndex(x=>x.id===d.id);
  const productId=String(d.decantProductId),lotId=String(d.perfumeLotId);
  return all.filter((x,index)=>x.status==="posted"&&x.id!==d.id&&x.perfumeStockOperationType!=="unit-conversion"&&(anchor>=0?index>anchor:String(x.occurredAt)>=String(d.occurredAt))&&(x.perfumeLotId===lotId||documentUsesPerfumeLot(x,productId,lotId)))
    .sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt)));
}

/** Undo a signed movement while retaining quantities restored by canceled sales.
 * A changed valuation or an active later operation still needs explicit reversal.
 */
export async function prepareLotDeltaUndo(db:Db,session:Session,d:Row,current:PerfumeLot):Promise<PerfumeLot>{
  const before=d.perfumeLotBefore as PerfumeLot|undefined,after=d.perfumeLotAfter as PerfumeLot|undefined;
  if(!before||!after)throw perfumeOperationBlocked("لا يمكن إثبات عكس هذه الحركة؛ صورة الدفعة قبلها أو بعدها مفقودة. لم يتم تغيير المخزون.");
  const later=await laterLotDocuments(db,session,d);
  if(later.length)throw perfumeOperationBlocked("ألغِ أو عدّل الحركة المرتبطة الأحدث أولًا:",later);
  const product=await db.collection("products").findOne({id:d.decantProductId},{session});
  const productLots=(Array.isArray(product?.perfumeLots)?product.perfumeLots:[]) as PerfumeLot[],stocks=(product?.stocks??{}) as Record<string,number>;
  const stockWarehouses=new Set([...Object.keys(stocks),...productLots.flatMap(l=>Object.keys(l.stocks))]);
  if(!product||[...stockWarehouses].some(wh=>roundMl(Number(stocks[wh]??0))!==roundMl(productLots.reduce((sum,l)=>sum+Number(l.stocks[wh]??0),0))))throw perfumeOperationBlocked("رصيد المنتج لا يطابق مجموع دفعاته؛ هذه مشكلة تطابق بيانات يجب مراجعتها قبل الإلغاء.");
  // Quantities can differ after reversing an earlier sale; definitions and costs cannot.
  const stable=(lot:PerfumeLot)=>{const copy={...lot} as Row;for(const key of ["remainingQuantity","stocks","settledAt"])delete copy[key];return Object.fromEntries(Object.entries(copy).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)))};
  if(JSON.stringify(stable(current))!==JSON.stringify(stable(after)))throw perfumeOperationBlocked("بيانات الدفعة أو تكلفتها تغيرت عن صورة العملية، ولم أجد حركة لاحقة نشطة تفسر ذلك. يلزم مراجعة البيانات قبل الإلغاء.");
  const warehouses=new Set([...Object.keys(current.stocks),...Object.keys(after.stocks)]);
  if([...warehouses].some(wh=>roundMl(Number(current.stocks[wh]??0)-Number(after.stocks[wh]??0))!==0)){
    const all=await db.collection("documents").find({},{session}).toArray(),anchor=all.findIndex(x=>x.id===d.id),restored:Record<string,number>={};
    for(const [index,sale] of all.entries()){
      const reversedAt=new Date(sale.voidedAt as string).getTime();
      if(index>=anchor||sale.status!=="voided"||!["sale","decant-sale"].includes(String(sale.kind))||!Number.isFinite(reversedAt)||reversedAt<new Date(String(d.occurredAt)).getTime())continue;
      for(const line of (Array.isArray(sale.lines)?sale.lines:[]) as Row[]){
        if(line.productId!==d.decantProductId)continue;
        for(const allocation of (Array.isArray(line.perfumeAllocations)?line.perfumeAllocations:[]) as Row[]){
          if(allocation.lotId!==current.id)continue;
          const factor=current.quantityUnit==="ml"&&allocation.quantityUnit!=="ml"?Number(product.legacyDecantUnitMl??1):1,wh=String(allocation.warehouseId??sale.warehouseId);
          restored[wh]=roundMl((restored[wh]??0)+Number(allocation.quantity)*factor);
        }
      }
    }
    if([...new Set([...warehouses,...Object.keys(restored)])].some(wh=>roundMl(Number(current.stocks[wh]??0)-Number(after.stocks[wh]??0))!==roundMl(restored[wh]??0)))throw perfumeOperationBlocked("تغيرت كمية الدفعة عن صورة العملية دون مستندات إلغاء تفسر الفرق كاملًا. هذه مشكلة تطابق بيانات وليست حركة مرتبطة نشطة؛ راجع البيانات قبل الإلغاء.");
  }
  const total=roundMl(Object.values(current.stocks).reduce((s,q)=>s+Number(q),0));
  if(total!==roundMl(Number(current.remainingQuantity))||Object.values(current.stocks).some(q=>!Number.isFinite(Number(q))||Number(q)<0))throw perfumeOperationBlocked("رصيد الدفعة لا يطابق مخازنها؛ لا يمكن إلغاء الحركة بأمان قبل مراجعة البيانات.");
  const wh=String(d.warehouseId),delta=Number(d.stockDelta);
  if(!Number.isFinite(delta)||roundMl(Number(after.remainingQuantity)-Number(before.remainingQuantity))!==roundMl(delta))throw perfumeOperationBlocked("فرق كمية العملية لا يطابق صور الدفعة؛ يلزم مراجعة البيانات قبل الإلغاء.");
  const remaining=roundMl(Number(current.remainingQuantity)-delta),warehouse=roundMl(Number(current.stocks[wh]??0)-delta);
  if(remaining<0||warehouse<0)throw perfumeOperationBlocked("لا تكفي الكمية الحالية لعكس زيادة الجرد. راجع حركات الدفعة قبل الإلغاء.");
  if(remaining>0&&Number(current.remainingQuantity)===0){
    const products=await db.collection("products").find({parentProductId:current.sourceProductId,perfumeForm:"decant"},{session}).toArray();
    const other=openSourceLots(products,current.sourceProductId,current.id);
    if(other.length){
      const all=await db.collection("documents").find({},{session}).toArray(),anchor=all.findIndex(x=>x.id===d.id),ids=new Set(other.map(x=>x.documentId));
      const docs=all.filter((x,index)=>x.status==="posted"&&ids.has(String(x.id))&&(anchor>=0?index>anchor:String(x.occurredAt)>String(d.occurredAt)));
      if(docs.length)throw perfumeOperationBlocked("إلغاء هذه الحركة يعيد فتح دفعة قديمة بينما توجد دفعة جديدة بها رصيد. عالج الدفعة الجديدة أولًا:",docs);
    }
  }
  const restored={...structuredClone(current),remainingQuantity:remaining,stocks:{...current.stocks,[wh]:warehouse}};
  if(d.perfumeStockOperationType==="reconciliation")restored.quantityAdjustmentMl=before.quantityAdjustmentMl;
  if(remaining>0){if(before.settledAt)restored.settledAt=before.settledAt;else delete restored.settledAt}else restored.settledAt=before.settledAt;
  return restored;
}
