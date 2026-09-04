import type { DocumentRecord, FinancialMovement, PartyFinancialSummary, PartyType } from "./domain";

/** Builds historical party totals without exposing the underlying cash movements. */
export function calculatePartyFinancialSummaries(
  documents: Array<Pick<DocumentRecord, "kind" | "status" | "partyId" | "total" | "lines">>,
  movements: Array<Pick<FinancialMovement, "partyId" | "direction" | "amount">>,
) {
  const summaries = new Map<string, PartyFinancialSummary>();
  const summary = (partyId: string) => {
    const existing = summaries.get(partyId);
    if (existing) return existing;
    const created: PartyFinancialSummary = { partyId, cashIn: 0, cashOut: 0, customerTradeTotal: 0, customerGrossProfit: 0, supplierTradeTotal: 0, supplierInvoiceCount: 0 };
    summaries.set(partyId, created);
    return created;
  };
  for (const movement of movements) {
    if (!movement.partyId) continue;
    const value = Number(movement.amount);
    if (!Number.isFinite(value)) continue;
    if (movement.direction === "in") summary(movement.partyId).cashIn += value;
    if (movement.direction === "out") summary(movement.partyId).cashOut += value;
  }
  for (const document of documents) {
    if (!document.partyId || document.status !== "posted") continue;
    const value = Number(document.total);
    if (!Number.isFinite(value)) continue;
    const party = summary(document.partyId);
    if (document.kind === "purchase") { party.supplierTradeTotal += value; party.supplierInvoiceCount += 1; }
    // Legacy read-only adjustments must keep historical customer totals unchanged.
    if (document.kind === "sale" || document.kind === "return") {
      const sign = document.kind === "return" ? -1 : 1;
      party.customerTradeTotal += sign * value;
      for (const line of document.lines ?? []) {
        const grossProfit = Number(line.grossProfit);
        if (line.grossProfit != null && Number.isFinite(grossProfit)) party.customerGrossProfit += sign * grossProfit;
      }
    }
  }
  return [...summaries.values()];
}

export function partyTradeMetrics(summary: PartyFinancialSummary | undefined, partyType: PartyType) {
  return partyType === "customer" ? { total: summary?.customerTradeTotal ?? 0, grossProfit: summary?.customerGrossProfit ?? 0 } : { total: summary?.supplierTradeTotal ?? 0, grossProfit: null };
}

export function partyAggregateMetrics(summaries: PartyFinancialSummary[], partyIds: string[], partyType: PartyType) {
  const allowed = new Set(partyIds);
  return summaries.filter(summary => allowed.has(summary.partyId)).reduce((total, summary) => {
    if (partyType === "customer") { total.tradeTotal += summary.customerTradeTotal; total.grossProfit += summary.customerGrossProfit; }
    else { total.tradeTotal += summary.supplierTradeTotal; total.invoiceCount += summary.supplierInvoiceCount; }
    total.cashIn += summary.cashIn; total.cashOut += summary.cashOut;
    return total;
  }, { tradeTotal: 0, cashIn: 0, cashOut: 0, grossProfit: 0, invoiceCount: 0 });
}
