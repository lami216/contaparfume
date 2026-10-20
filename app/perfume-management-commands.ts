import type { SqliteDatabase as Db, SqliteSession as Session } from "../lib/sqlite.ts";
import { managementKind, managementPostType, type ManagementKind } from "./perfume-management.ts";
import { perfumeLotEquals } from "./perfume-stock-reconciliation.ts";
import type { PerfumeLot } from "./perfume-logic.ts";

type Row = Record<string, unknown>;
type Delegate = (db: Db, session: Session, body: Row) => Promise<unknown>;
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];
const lotsOf = (product: Row): PerfumeLot[] => structuredClone(Array.isArray(product.perfumeLots) ? product.perfumeLots : []);
const total = (product: Row) => Object.values((product.stocks ?? {}) as Record<string, number>).reduce((a,b) => a + Number(b), 0);
const meta = (product: Row) => ({ name: product.name, piecePrice: product.piecePrice ?? null });
const snapshotBottle = (product: Row) => ({ name: product.name, sizeMl: product.decantSizeMl, cost: product.pieceCost, isArchived: product.isArchived === true });
const positive = (value: unknown, label: string) => { const n=Number(value); if(!Number.isFinite(n)||n<=0)throw fail(`${label} غير صالح`,400);return n; };
const commandKinds = new Map(Object.entries(managementPostType).map(([kind,command]) => [command,kind as ManagementKind]));
const inputFields = ["sourceProductId","decantProductId","lotId","warehouseId","divisionsCount","salePrice","quantity","remainingValue","actualQuantity","reason","reasonCode","consumeBottle","bottleProductId","name","sizeMl","cost","note"];
const cleanInput = (body: Row) => Object.fromEntries(inputFields.filter(key => body[key] !== undefined).map(key => [key,body[key]]));
const stockConflict = () => fail("لا يمكن تعديل أو إلغاء العملية لأن لها حركات لاحقة. ألغِ الحركات المرتبطة الأحدث أولًا.");

/** No business mutation is made outside the caller's SQLite/idempotency transaction. */
export async function handlePerfumeManagementCommand(db: Db, session: Session, body: Row, base: Delegate, core: Delegate): Promise<{handled:boolean;result?:unknown}> {
  const type=String(body.type??""),kind=commandKinds.get(type);
  const products=db.collection("products"),documents=db.collection("documents");
  const product = async (value: unknown) => { const p=await products.findOne({id:String(value??"")},{session});if(!p)throw fail("المنتج المرتبط بالعملية غير موجود",404);return p; };
  const document = async () => {
    const d=await documents.findOne({id:String(body.documentId??"")},{session});
    if(!d||!managementKind(d))throw fail("سند إدارة التقسيمات غير موجود",404);
    if(d.status!=="posted")throw fail("العملية ملغاة أو تم تعديلها. افتح أحدث سجل.");
    if(body.expectedRevision!==undefined&&Number(body.expectedRevision)!==Number(d.revision??0))throw fail("تغيرت العملية. حدّث الصفحة وأعد المحاولة.");
    return d;
  };
  async function move(p: Row, warehouseId: string, delta: number, d: Row, name: string) {
    const warehouse=await db.collection("warehouses").findOne({_id:warehouseId},{session});if(!warehouse)throw fail("المخزن المرتبط بالعملية غير موجود");
    const before=Number((p.stocks as Record<string,number>??{})[warehouseId]??0),after=before+delta;
    if(!Number.isFinite(after)||after<0)throw stockConflict();
    await products.updateOne({id:p.id},{$set:{[`stocks.${warehouseId}`]:after}},{session});
    p.stocks={...(p.stocks as Row??{}),[warehouseId]:after};
    await db.collection("stockMovements").insertOne({id:id("mov"),documentId:d.id,documentNumber:d.number,warehouseId,warehouseName:warehouse.name,productId:p.id,productName:p.name,type:name,quantityDelta:delta,balanceBefore:before,balanceAfter:after,occurredAt:new Date().toISOString()},{session});
  }
  async function setLots(p: Row,lots:PerfumeLot[]) {
    // Lot book values are authoritative. Do not reset prices or another lot's stock.
    await products.updateOne({id:p.id},{$set:{perfumeLots:lots}},{session});p.perfumeLots=lots;
  }
  async function definition(p: Row, input: Row, before: Row|null, previous?:Row) {
    const d={id:id("adjustment"),number:`BDEF-${Date.now()}-${crypto.randomUUID().slice(0,6)}`,kind:"adjustment",status:"posted",occurredAt:new Date().toISOString(),perfumeManagementType:"bottle",managementProductId:String(p.id),managementInput:input,bottleDefinitionBefore:before,bottleDefinitionAfter:snapshotBottle(p),revision:0,title:String(p.name),note:String(input.note??""),partyId:null,partyName:null,warehouseId:null,warehouseName:null,parentDocumentId:null,paymentMethod:null,total:0,paidTotal:0,dueTotal:0,lines:[{id:id("line"),productId:String(p.id),description:String(p.name),quantity:0,unitPrice:0,lineTotal:0}]};
    await documents.insertOne(d,{session});
    if(previous)await linkRevision(previous,d.id);
    return d;
  }
  async function linkRevision(old:Row,newId:unknown) {
    await documents.updateOne({id:old.id},{$set:{status:"voided",voidedAt:new Date().toISOString(),replacedByDocumentId:newId,voidReason:"تعديل العملية مع الاحتفاظ بالنسخة السابقة"}},{session});
    await documents.updateOne({id:newId},{$set:{replacesDocumentId:old.id,revision:Number(old.revision??0)+1}},{session});
  }
  async function post(postKind:ManagementKind,input:Row) {
    let previousDecant:Row|null=null,previousLot:PerfumeLot|null=null;
    if(["split","opening"].includes(postKind))previousDecant=(await products.findOne({parentProductId:String(input.sourceProductId),perfumeForm:"decant",isArchived:{$ne:true}},{session}))??null;
    if(postKind==="recombine")previousLot=lotsOf(await product(input.decantProductId)).find(l=>l.id===input.lotId)??null;
    const payload={...input,type:managementPostType[postKind]};
    let result:unknown;
    if(postKind==="bottle-stock"){
      const p=await product(input.bottleProductId);if(p.perfumeForm!=="bottle"||p.isArchived)throw fail("اختر زجاجة نشطة",400);
      const actual=Number(input.actualQuantity);if(!Number.isSafeInteger(actual)||actual<0)throw fail("الكمية الفعلية غير صالحة",400);
      if(!String(input.reason??"").trim())throw fail("سبب التصحيح مطلوب",400);
      result=await core(db,session,{type:"adjustment.post",warehouseId:input.warehouseId,reason:input.reason,lines:[{productId:p.id,actualQuantity:actual,purchaseCost:actual>Number((p.stocks as Row??{})[String(input.warehouseId)]??0)?positive(input.cost,"قيمة وحدة الزجاج"):null}]});
    }else result=await base(db,session,payload);
    if(postKind==="bottle"){
      const p=await product(result);const d=await definition(p,cleanInput(input),null);return {result,documentId:d.id};
    }
    let d=await documents.findOne({id:String(result)},{session});
    if(postKind==="recombine")d=await documents.findOne({perfumeConversionType:"perfume-recombine",status:"posted","lines.productId":String(result)},{session});
    if(!d)throw fail("تعذر ربط العملية بسجل الفواتير");
    const added:Row={perfumeManagementType:postKind,managementInput:cleanInput(input),revision:0,note:String(input.note??input.reason??"")};
    if(postKind==="split"){
      const line=rows(d.lines).find(l=>Number(l.quantity)>0);const p=await product(line?.productId);const lot=lotsOf(p).find(l=>l.conversionDocumentId===d!.id);if(!lot)throw fail("دفعة التحويل غير موجودة");
      Object.assign(added,{sourceProductId:String(input.sourceProductId),decantProductId:String(p.id),perfumeLotId:lot.id,perfumeLotBefore:null,perfumeLotAfter:lot,decantProductCreated:!previousDecant,decantProductBefore:previousDecant?meta(previousDecant):null,decantProductAfter:meta(p)});
    }
    if(postKind==="recombine"){
      const p=await product(input.decantProductId);Object.assign(added,{decantProductId:String(p.id),perfumeLotId:String(input.lotId),partialProductId:String(result),perfumeLotBefore:previousLot,perfumeLotAfter:lotsOf(p).find(l=>l.id===input.lotId)});
    }
    if(postKind==="bottle-stock")added.managementProductId=String(input.bottleProductId);
    await documents.updateOne({id:d.id},{$set:added},{session});return {result,documentId:String(d.id)};
  }
  async function undo(d:Row) {
    const k=managementKind(d)!;
    if(["opening","consumption","yield-correction"].includes(k)){
      await base(db,session,{type:"perfume-stock-operation.void",documentId:d.id});return;
    }
    if(k==="bottle-stock"){await core(db,session,{type:"adjustment.void",documentId:d.id});return;}
    if(k==="bottle"){
      const p=await product(d.managementProductId);if(total(p)!==0)throw fail("لا يمكن أرشفة زجاجة لها مخزون. صحح الرصيد أو انقل الكميات أولًا.");
      await base(db,session,{type:"product.delete",id:p.id});
    } else {
      const lines=rows(d.lines),wh=String(d.warehouseId);
      const incoming=lines.find(l=>Number(l.quantity)>0),outgoing=lines.find(l=>Number(l.quantity)<0);
      const p=await product(d.decantProductId??(k==="split"?incoming?.productId:outgoing?.productId)),lots=lotsOf(p);
      const partialId=String(d.partialProductId??incoming?.productId??"");
      const index=lots.findIndex(l=>l.id===d.perfumeLotId||(k==="split"?l.conversionDocumentId===d.id:l.partialProductId===partialId));
      if(index<0||!incoming||!outgoing)throw stockConflict();
      const lot=lots[index],expected=d.perfumeLotAfter as PerfumeLot|undefined;
      if(expected&&!perfumeLotEquals(lot,expected))throw stockConflict();
      if(k==="split"){
        const qty=Number(incoming.quantity),stock=Object.values(lot.stocks).reduce((s,q)=>s+q,0);
        if(lot.originalQuantity!==qty||lot.remainingQuantity!==qty||stock!==qty||Number(lot.stocks[wh])!==qty||lot.recombinedAt||Math.abs(lot.liquidUnitCost-Number(incoming.unitPrice))>1e-9)throw stockConflict();
        const source=await product(outgoing.productId);
        await move(p,wh,-qty,d,"perfume-split-void-out");await move(source,wh,1,d,"perfume-split-void-in");lots.splice(index,1);await setLots(p,lots);
        if(d.decantProductCreated===true&&lots.length===0&&total(p)===0)await products.updateOne({id:p.id},{$set:{isArchived:true,archivedAt:new Date()}},{session});
        const before=d.decantProductBefore as Row|null,after=d.decantProductAfter as Row|null;
        if(before&&after&&JSON.stringify(meta(p))===JSON.stringify(after))await products.updateOne({id:p.id},{$set:before},{session});
      } else {
        const partial=await product(partialId),qty=-Number(outgoing.quantity);
        if(partial.isArchived||total(partial)!==1||Number((partial.stocks as Row??{})[wh])!==1||lot.remainingQuantity!==0||lot.partialProductId!==partialId)throw stockConflict();
        // Older recombinations predate snapshots; their signed document lines,
        // closed lot and intact single partial bottle provide the inverse values.
        let before=d.perfumeLotBefore as PerfumeLot|undefined;
        if(!before){before={...structuredClone(lot),remainingQuantity:qty,stocks:{...lot.stocks,[wh]:qty}};delete before.recombinedAt;delete before.partialProductId;}
        if(!Number.isSafeInteger(qty)||qty<=0||before.remainingQuantity!==qty)throw stockConflict();
        await move(partial,wh,-1,d,"perfume-recombine-void-out");await move(p,wh,qty,d,"perfume-recombine-void-in");lots[index]=before;await setLots(p,lots);
        await products.updateOne({id:partial.id},{$set:{isArchived:true,archivedAt:new Date()}},{session});
      }
    }
    await documents.updateOne({id:d.id,status:"posted"},{$set:{status:"voided",voidedAt:new Date().toISOString(),voidReason:String(body.reason??"إلغاء من إدارة التقسيمات")}},{session});
  }
  if(kind){const made=await post(kind,body);return {handled:true,result:made.result};}
  if(["perfume-bottle.update","perfume-bottle.archive","perfume-bottle.restore"].includes(type)){
    const p=await product(body.id);if(p.perfumeForm!=="bottle")throw fail("المنتج ليس زجاجة تقسيمات",400);
    const before=snapshotBottle(p);
    if(body.expectedProduct&&JSON.stringify(body.expectedProduct)!==JSON.stringify(before))throw fail("تغيرت الزجاجة. حدّث الصفحة وأعد المحاولة.");
    const prior=await documents.findOne({perfumeManagementType:"bottle",managementProductId:String(p.id),status:"posted"},{session,sort:{occurredAt:-1}});
    if(type==="perfume-bottle.archive"){
      const d=prior??await definition(p,{name:p.name,sizeMl:p.decantSizeMl,cost:p.pieceCost},before);await undo(d);return {handled:true,result:d.id};
    }
    if(type==="perfume-bottle.restore"){
      if(!p.isArchived)throw fail("الزجاجة نشطة بالفعل");
      await base(db,session,{type:"product.restore",id:p.id});const fresh=await product(p.id);const d=await definition(fresh,{name:fresh.name,sizeMl:fresh.decantSizeMl,cost:fresh.pieceCost},before);return {handled:true,result:d.id};
    }
    if(p.isArchived)throw fail("استعد الزجاجة من الأرشيف قبل تعديلها");
    const name=String(body.name??"").trim(),size=positive(body.sizeMl,"حجم الزجاجة"),cost=positive(body.cost,"التكلفة المرجعية");
    if(!name||name.length>160)throw fail("اسم الزجاجة غير صالح",400);
    if(await products.findOne({id:{$ne:p.id},perfumeForm:"bottle",name,decantSizeMl:size,isArchived:{$ne:true}},{session}))throw fail("زجاجة بنفس الاسم والحجم موجودة بالفعل");
    await products.updateOne({id:p.id},{$set:{name,decantSizeMl:size,pieceCost:cost,updatedAt:new Date()}},{session});
    const fresh=await product(p.id);const d=await definition(fresh,{name,sizeMl:size,cost,note:String(body.note??"")},before,prior??undefined);return {handled:true,result:d.id};
  }
  if(type==="perfume-management.void"||type==="perfume-stock-operation.void"){
    const d=await document();await undo(d);return {handled:true,result:d.id};
  }
  if(type==="perfume-management.update"){
    const d=await document(),k=managementKind(d)!;
    if(k==="bottle")return handlePerfumeManagementCommand(db,session,{...body,type:"perfume-bottle.update",id:d.managementProductId},base,core);
    // A correction is a new linked revision. The prior document, all its lines
    // and reversal movements remain queryable; failure rolls the entire edit back.
    await undo(d);
    const made=await post(k,body);await linkRevision(d,made.documentId);return {handled:true,result:made.documentId};
  }
  if(type==="adjustment.update"||type==="adjustment.void"){
    const d=await documents.findOne({id:String(body.documentId??"")},{session});
    if(d&&managementKind(d))throw fail("استخدم إدارة التقسيمات لتعديل أو إلغاء هذه العملية حتى تبقى الدفعات متطابقة.");
  }
  return {handled:false};
}
