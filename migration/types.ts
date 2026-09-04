export type ImportSourceType = "dataacc-sqlite" | "generic-sqlite" | "csv" | "xlsx" | "json";
export type CanonicalEntityType = "products"|"warehouses"|"stockBalances"|"parties"|"paymentAccounts"|"financialMovements"|"sales"|"purchases"|"expenses";
export type CanonicalEntity = { sourceKey:string; sourceTable?:string; sourceId?:string; name?:string; normalizedName?:string; barcode?:string; sku?:string; phone?:string; role?:"customer"|"supplier"; balance?:number; quantity?:number; productSourceKey?:string; warehouseSourceKey?:string; data?:Record<string,unknown> };
export type UnknownImportGroup = { key:string; label:string; count:number; reason:string; columns:string[]; manualMappingSupported:boolean };
export type CanonicalImportPackage = { source:{type:ImportSourceType;filename?:string;fingerprint?:string}; entities:Record<CanonicalEntityType,CanonicalEntity[]>; unknownGroups:UnknownImportGroup[]; warnings:string[] };
export type MatchType = "exact"|"probable"|"none"|"conflict";
export type MatchReason = "legacyKey"|"mapping"|"barcode"|"sku"|"normalizedName"|"phone"|"ambiguous"|"none";
export type EntityMatch = { sourceKey:string;matchType:MatchType;confidence:number;reason:MatchReason;targetId?:string;candidates?:Array<{id:string;name:string}> };
export type ReviewDecision = "link"|"create"|"ignore";
export type StockPolicy = "keep-current"|"use-imported"|"manual-resolution";
export type AccountBalancePolicy = "keep-current"|"use-imported"|"adjustment";
export interface ImportSourceAdapter { readonly type:ImportSourceType; detect(bytes:Uint8Array):boolean|Promise<boolean>; inspect(bytes:Uint8Array,filename?:string):Promise<CanonicalImportPackage> }
