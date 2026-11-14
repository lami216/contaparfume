export type ExpenseCategoryKind = "recurring" | "nonrecurring";

export function expenseCategoryKind(category?: { kind?: unknown } | null): ExpenseCategoryKind {
  return category?.kind === "nonrecurring" ? "nonrecurring" : "recurring";
}

export function expenseCategoryKindLabel(category?: { kind?: unknown } | null) {
  return expenseCategoryKind(category) === "nonrecurring" ? "غير متكررة" : "متكررة";
}
