import { resolvePartyType, type FinancialMovement, type Party, type PaymentAccount } from "./domain";

export type CommittedPeriod = { from: string; to: string } | null;
export const inCommittedPeriod = (occurredAt: string, period: CommittedPeriod) => !period || ((!period.from || occurredAt.slice(0, 10) >= period.from) && (!period.to || occurredAt.slice(0, 10) <= period.to));
export function financialMovementKind(type: unknown) { const value=String(type??""); if(value==="decant-sale"||value.startsWith("sale:"))return "sale"; if(value==="decant-purchase"||value.startsWith("purchase:"))return "purchase"; return value; }
export function filterFinancialMovements(rows: FinancialMovement[], period: CommittedPeriod, accountId = "", type = "") { return rows.filter(row => inCommittedPeriod(row.occurredAt, period) && (!accountId || row.paymentMethod === accountId) && (!type || financialMovementKind(row.type) === type)); }
export function filterTransfers<T extends { occurredAt: string; fromAccountId: string; toAccountId: string }>(rows: T[], period: CommittedPeriod, fromAccountId = "", toAccountId = "") { return rows.filter(row => inCommittedPeriod(row.occurredAt, period) && (!fromAccountId || row.fromAccountId === fromAccountId) && (!toAccountId || row.toAccountId === toAccountId)); }
const nonOperatingMovementTypes = new Set(["transfer-in", "transfer-out", "opening-balance", "opening-balance-correction", "balance-correction"]);
export const bankSummaryMovementKinds = {
  in: ["sale","party-receipt:customer","party-receipt:supplier","manual-deposit"],
  out: ["purchase","expense","party-payment:customer","party-payment:supplier","manual-withdrawal"],
} as const;
export type BankSummaryMovementBreakdown = { kind:string; count:number; value:number };
export function bankScopeBreakdown(accounts: PaymentAccount[], movements: FinancialMovement[], parties: Party[]) {
  const accountsUsed=accounts.filter(account=>!account.isArchived).map(account=>({id:account.id,name:account.name,isActive:account.isActive,value:Number(account.balance||0)}));
  const partyTypes=new Map(parties.map(party=>[party.id,resolvePartyType(party)] as const));
  const buckets={in:new Map<string,{count:number;value:number}>(),out:new Map<string,{count:number;value:number}>()},found={in:[] as string[],out:[] as string[]},seen={in:new Set<string>(),out:new Set<string>()};
  for(const movement of movements){
    const baseKind=financialMovementKind(movement.type);
    if(nonOperatingMovementTypes.has(baseKind)||(movement.direction!=="in"&&movement.direction!=="out"))continue;
    const direction=movement.direction,kind=(baseKind==="party-receipt"||baseKind==="party-payment")?`${baseKind}:${movement.partyId?partyTypes.get(movement.partyId)??"unknown":"unknown"}`:baseKind,current=buckets[direction].get(kind)??{count:0,value:0};
    current.count+=1;current.value+=Number(movement.amount||0);buckets[direction].set(kind,current);
    if(!seen[direction].has(kind)){seen[direction].add(kind);found[direction].push(kind)}
  }
  const movementRows=(direction:"in"|"out"):BankSummaryMovementBreakdown[]=>{const configured=[...bankSummaryMovementKinds[direction]] as string[],kinds=[...configured,...found[direction].filter(kind=>!configured.includes(kind))];return kinds.map(kind=>({kind,...(buckets[direction].get(kind)??{count:0,value:0})}))};
  const partyRows=parties.map(party=>{const net=Number(party.receivable||0)-Number(party.payable||0);return{id:party.id,name:party.name,partyType:party.partyType,isArchived:party.isArchived===true,owedToUs:Math.max(net,0),weOwe:Math.max(-net,0)}});
  return {accounts:accountsUsed,income:movementRows("in"),expenses:movementRows("out"),parties:partyRows};
}
export function bankScopeMetrics(accounts: PaymentAccount[], movements: FinancialMovement[], parties: Party[]) {
  let currentBalance=0,income=0,expenses=0,owedToUs=0,weOwe=0;
  for(const account of accounts)if(!account.isArchived)currentBalance+=Number(account.balance||0);
  for(const movement of movements){if(nonOperatingMovementTypes.has(financialMovementKind(movement.type)))continue;const amount=Number(movement.amount||0);if(movement.direction==="in")income+=amount;else if(movement.direction==="out")expenses+=amount}
  for(const party of parties){const net=Number(party.receivable||0)-Number(party.payable||0);if(net>0)owedToUs+=net;else if(net<0)weOwe+=Math.abs(net)}
  return { currentBalance, income, expenses, owedToUs, weOwe };
}
