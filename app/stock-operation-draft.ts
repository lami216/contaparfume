export type StockOperationMode = "transfer" | "adjust";

export function stockOperationDraftKeys(mode: StockOperationMode) {
  return [`${mode}-from`, `${mode}-to`, `${mode}-reason`, `${mode}-lines`] as const;
}

/** A historical edit must never survive as a new-operation draft after cancel,
 * delete or navigation. Clear storage synchronously before the editor remounts. */
export function clearStockOperationDraft(storage: Pick<Storage, "removeItem">, mode: StockOperationMode) {
  for (const key of stockOperationDraftKeys(mode)) storage.removeItem(`conta:${key}`);
}
