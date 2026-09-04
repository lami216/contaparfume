import type { CanonicalEntity, CanonicalEntityType, EntityMatch, MatchReason } from "./types.ts";

export const normalizeImportText=(value:unknown)=>String(value??"").trim().toLocaleLowerCase("ar").replace(/[ـ\u064B-\u065F]/g,"").replace(/\s+/g," ");
type Target={id?:unknown;_id?:unknown;name?:unknown;nameNormalized?:unknown;legacyKey?:unknown;barcode?:unknown;sku?:unknown;phone?:unknown;partyType?:unknown};
const targetId=(v:Target)=>String(v.id??v._id??"");
const unique=(targets:Target[],predicate:(target:Target)=>boolean)=>targets.filter(predicate);
export function matchCanonicalEntity(type:CanonicalEntityType,source:CanonicalEntity,targets:Target[],mappedTargetId?:string):EntityMatch{
 const result=(matchType:EntityMatch["matchType"],confidence:number,reason:MatchReason,found?:Target,candidates?:Target[]):EntityMatch=>({sourceKey:source.sourceKey,matchType,confidence,reason,targetId:found?targetId(found):undefined,candidates:candidates?.map(x=>({id:targetId(x),name:String(x.name??"")}))});
 if(mappedTargetId){const mapped=targets.find(x=>targetId(x)===mappedTargetId);if(mapped)return result("exact",1,"mapping",mapped)}
 const legacy=unique(targets,x=>String(x.legacyKey??"")===source.sourceKey);if(legacy.length===1)return result("exact",1,"legacyKey",legacy[0]);
 const exact=(reason:MatchReason,matches:Target[],confidence=.98)=>matches.length===1?result("exact",confidence,reason,matches[0]):matches.length>1?result("conflict",.4,"ambiguous",undefined,matches):null;
 if(type==="products"&&source.barcode){const m=exact("barcode",unique(targets,x=>String(x.barcode??"")===source.barcode));if(m)return m}
 if(type==="products"&&source.sku){const m=exact("sku",unique(targets,x=>String(x.sku??"")===source.sku),.92);if(m)return m}
 if(type==="parties"&&source.phone){const m=exact("phone",unique(targets,x=>String(x.phone??"")===source.phone&&(!source.role||x.partyType===source.role)));if(m)return m}
 const normalized=source.normalizedName||normalizeImportText(source.name);if(normalized){const matches=unique(targets,x=>(String(x.nameNormalized??"")||normalizeImportText(x.name))===normalized&&(type!=="parties"||!source.role||x.partyType===source.role));if(matches.length===1){const safe=type==="warehouses"||type==="paymentAccounts"||type==="parties";return result(safe?"exact":"probable",safe?.9:.72,"normalizedName",matches[0])}if(matches.length>1)return result("conflict",.35,"ambiguous",undefined,matches)}
 return result("none",0,"none");
}
