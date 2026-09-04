import type { FinancialMovement, Party, PaymentAccount } from "./domain";

export type CommittedPeriod = { from: string; to: string } | null;
export const inCommittedPeriod = (occurredAt: string, period: CommittedPeriod) => !period || ((!period.from || occurredAt.slice(0, 10) >= period.from) && (!period.to || occurredAt.slice(0, 10) <= period.to));
export function filterFinancialMovements(rows: FinancialMovement[], period: CommittedPeriod, accountId = "", type = "") { return rows.filter(row => inCommittedPeriod(row.occurredAt, period) && (!accountId || row.paymentMethod === accountId) && (!type || row.type === type)); }
export function filterTransfers<T extends { occurredAt: string; fromAccountId: string; toAccountId: string }>(rows: T[], period: CommittedPeriod, fromAccountId = "", toAccountId = "") { return rows.filter(row => inCommittedPeriod(row.occurredAt, period) && (!fromAccountId || row.fromAccountId === fromAccountId) && (!toAccountId || row.toAccountId === toAccountId)); }
const nonOperatingMovementTypes = new Set(["transfer-in", "transfer-out", "opening-balance", "balance-correction"]);
export function bankScopeMetrics(accounts: PaymentAccount[], movements: FinancialMovement[], parties: Party[]) {
  const currentBalance = accounts.filter(account => account.isActive && !account.isArchived).reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const operating = movements.filter(movement => !nonOperatingMovementTypes.has(movement.type));
  const income = operating.filter(movement => movement.direction === "in").reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
  const expenses = operating.filter(movement => movement.direction === "out").reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
  const debt = parties.reduce((totals, party) => { const net = Number(party.receivable || 0) - Number(party.payable || 0); if (net > 0) totals.owedToUs += net; else totals.weOwe += Math.abs(net); return totals; }, { owedToUs: 0, weOwe: 0 });
  return { currentBalance, income, expenses, ...debt };
}
