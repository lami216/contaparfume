import type { SqliteDatabase as Db } from "../lib/sqlite.ts";
import type { CanonicalEntityType, CanonicalImportPackage, EntityMatch } from "./types.ts";
import { matchCanonicalEntity } from "./matching.ts";
const collections:Partial<Record<CanonicalEntityType,string>>={products:"products",warehouses:"warehouses",parties:"parties",paymentAccounts:"paymentAccounts"};
export async function buildImportPreview(db:Db,pkg:CanonicalImportPackage){
 const mappings=await db.collection("importMappings").find({sourceType:pkg.source.type,sourceKey:{$in:Object.values(pkg.entities).flat().map(x=>x.sourceKey)}}).toArray();
 const groups=[] as Array<{key:CanonicalEntityType;label:string;count:number;created:number;matched:number;review:number;skipped:number;unsupported:number;matches:EntityMatch[]}>;
 const labels:Record<CanonicalEntityType,string>={products:"المنتجات",warehouses:"المخازن",stockBalances:"أرصدة المخزون",parties:"العملاء والموردون",paymentAccounts:"الحسابات والبنوك",financialMovements:"الحركات المالية",sales:"فواتير البيع",purchases:"فواتير الشراء",expenses:"المصاريف"};
 for(const [key,entities] of Object.entries(pkg.entities) as [CanonicalEntityType,typeof pkg.entities.products][]){const collection=collections[key],targets=collection?await db.collection(collection).find({}).toArray():[],matches=entities.map(entity=>matchCanonicalEntity(key,entity,targets,String(mappings.find(x=>x.sourceKey===entity.sourceKey)?.targetId??"")||undefined));groups.push({key,label:labels[key],count:entities.length,created:matches.filter(x=>x.matchType==="none").length,matched:matches.filter(x=>x.matchType==="exact").length,review:matches.filter(x=>x.matchType==="probable"||x.matchType==="conflict").length,skipped:0,unsupported:0,matches})}
 return {format:pkg.source.type,source:pkg.source,groups,unknownGroups:pkg.unknownGroups,warnings:pkg.warnings,criticalConflicts:groups.reduce((n,g)=>n+g.matches.filter(x=>x.matchType==="conflict").length,0)};
}
