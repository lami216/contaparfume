import { displayDocumentNumber, type DocumentRecord } from "./domain";

export type ExpenseHistoryFilters = { query: string; from: string; to: string; allTime: boolean };

export function expenseSearchMode(filters: ExpenseHistoryFilters, query: string): ExpenseHistoryFilters {
  if (!query.trim()) return { ...filters, query };
  return { query, from: "", to: "", allTime: true };
}

export function expenseDateMode(filters: ExpenseHistoryFilters, boundary: "from" | "to", value: string): ExpenseHistoryFilters {
  return { ...filters, query: "", [boundary]: value, allTime: false };
}

export function expenseAllTimeMode(): ExpenseHistoryFilters {
  return { query: "", from: "", to: "", allTime: true };
}

function normalizeExpenseSearch(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function expenseSearchScore(document: DocumentRecord, query: string) {
  const term = normalizeExpenseSearch(query);
  if (!term) return 0;
  const fields = [document.title, displayDocumentNumber(document), document.number, document.legacyBillCode];
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of fields) {
    const field = normalizeExpenseSearch(candidate);
    if (!field) continue;
    if (field === term) best = Math.min(best, 0);
    else if (field.startsWith(term)) best = Math.min(best, 1);
    else if (field.split(" ").some(word => word.startsWith(term))) best = Math.min(best, 2);
    else if (field.includes(term)) best = Math.min(best, 3);
  }
  return best;
}

export function rankExpenseDocuments(documents: DocumentRecord[], query: string) {
  const term = normalizeExpenseSearch(query);
  const normallyOrdered = sortDocumentsBySequence(documents);
  if (!term) return normallyOrdered;
  return normallyOrdered.map((document, index) => ({ document, index, score: expenseSearchScore(document, term) }))
    .filter(result => Number.isFinite(result.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ document }) => document);
}

export function localBusinessDay(value: Date | string = new Date()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function sortDocumentsBySequence(documents: DocumentRecord[]) {
  return documents.map((document, index) => ({ document, index })).sort((left, right) => {
    const leftSequence = Number(left.document.sequence);
    const rightSequence = Number(right.document.sequence);
    const leftSequenced = Number.isSafeInteger(leftSequence) && leftSequence > 0;
    const rightSequenced = Number.isSafeInteger(rightSequence) && rightSequence > 0;
    if (leftSequenced && rightSequenced) return rightSequence - leftSequence || left.index - right.index;
    if (leftSequenced !== rightSequenced) return leftSequenced ? -1 : 1;
    return left.index - right.index;
  }).map(({ document }) => document);
}

export function filterDocumentsByDate(documents: DocumentRecord[], from: string, to: string, allTime: boolean) {
  const filtered = allTime ? documents : documents.filter(document => {
    const day = document.businessDate ?? localBusinessDay(document.occurredAt);
    return (!from || day >= from) && (!to || day <= to);
  });
  return sortDocumentsBySequence(filtered);
}
