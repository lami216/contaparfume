import {reportNumber} from "./report-types.ts";

const costDependentFields=new Set(["cost","profit","margin","salesCost","salesProfit","netOperatingResult","netProfit","netProfitAfterInventoryLoss"]);
export function reportHasUnknownCost(state:unknown):boolean {
  if(!state||typeof state!=="object")return false;
  const values=state as Record<string,unknown>;
  return values.costKnown===false||reportNumber(values.unknownRevenue)>0;
}
export function reportCostUnknown(key:string,state:unknown):boolean {
  return costDependentFields.has(key)&&reportHasUnknownCost(state);
}
/** Export the same uncertainty that is shown on screen; never turn it into zero. */
export function reportCostExportValue(key:string,value:unknown,state:unknown,unknownLabel:string):number|string {
  return reportCostUnknown(key,state)?unknownLabel:reportNumber(value);
}
