export type ReadModelDocument = Record<string, unknown> & {
  kind?: unknown;
  status?: unknown;
  partyId?: unknown;
  partyName?: unknown;
  partyNameOriginal?: unknown;
};

export type DocumentReadAccess = {
  can: (capability: string) => boolean;
  customerPartyIds: ReadonlySet<string>;
  supplierPartyIds: ReadonlySet<string>;
};

const partyIdOf = (document: ReadModelDocument) =>
  typeof document.partyId === "string" ? document.partyId : "";
const canAny = (can: DocumentReadAccess["can"], capabilities: readonly string[]) =>
  capabilities.some(capability => can(capability));

// Existing-record reads follow view/edit/delete authority. Create-only authority
// stays separate so it never broadens historical visibility by itself.
const saleAccess = ["pos.view", "pos.edit", "pos.delete"] as const;
const purchaseAccess = ["purchases.view", "purchases.edit", "purchases.delete"] as const;
const expenseAccess = ["expenses.view", "expenses.edit", "expenses.delete"] as const;
const customerAccess = ["customers.view", "customers.edit", "customers.delete", "customers.collect.edit", "customers.collect.delete"] as const;
const supplierAccess = ["suppliers.view", "suppliers.edit", "suppliers.delete", "suppliers.pay.edit", "suppliers.pay.delete"] as const;
const transferAccess = ["warehouses.transfer", "warehouses.transfer.edit", "warehouses.transfer.delete"] as const;
const adjustmentAccess = ["warehouses.adjust", "warehouses.adjust.edit", "warehouses.adjust.delete"] as const;
const accountTransferAccess = ["banks.view", "banks.movements.view", "banks.transfer.edit", "banks.transfer.delete"] as const;
const accountAdjustmentAccess = ["banks.view", "banks.movements.view", "banks.deposit_withdraw.edit", "banks.deposit_withdraw.delete"] as const;

/**
 * `documents` in bootstrap is the operational read model. Voided records stay in
 * storage for audit/history, but must not leak back into normal screens as if
 * they were still active transactions.
 */
export function isOperationalDocument(document: ReadModelDocument) {
  return document.status === "posted";
}

/** Coarse kind authorization, used before historical queries expose a kind. */
export function canReadDocumentKind(kind: string, access: Pick<DocumentReadAccess, "can">) {
  if (access.can("records.view")) return true;
  if (kind === "sale") return canAny(access.can, saleAccess) || canAny(access.can, customerAccess);
  if (kind === "purchase") return canAny(access.can, purchaseAccess) || canAny(access.can, supplierAccess);
  if (kind === "decant-sale" || kind === "decant-purchase") return access.can("perfume.divisions.view") || access.can("perfume.divisions.manage");
  if (kind === "expense") return canAny(access.can, expenseAccess);
  if (kind === "transfer") return canAny(access.can, transferAccess);
  if (kind === "adjustment") return canAny(access.can, adjustmentAccess);
  if (kind === "account-transfer") return canAny(access.can, accountTransferAccess);
  if (kind === "account-adjustment") return canAny(access.can, accountAdjustmentAccess);
  if (["payment", "settlement", "offset", "return"].includes(kind)) return canAny(access.can, customerAccess) || canAny(access.can, supplierAccess);
  return false;
}

/** One authorization rule for both live documents and historical/audit reads. */
export function canReadDocument(document: ReadModelDocument, access: DocumentReadAccess) {
  if (access.can("records.view")) return true;

  const kind = String(document.kind ?? ""), partyId = partyIdOf(document);
  const customerParty = Boolean(partyId) && access.customerPartyIds.has(partyId);
  const supplierParty = Boolean(partyId) && access.supplierPartyIds.has(partyId);

  if (kind === "sale") return canAny(access.can, saleAccess) || (customerParty && canAny(access.can, customerAccess));
  if (kind === "purchase") return canAny(access.can, purchaseAccess) || (supplierParty && canAny(access.can, supplierAccess));
  if (kind === "decant-sale" || kind === "decant-purchase") return access.can("perfume.divisions.view") || access.can("perfume.divisions.manage");
  if (kind === "expense") return canAny(access.can, expenseAccess);
  if (kind === "transfer") return canAny(access.can, transferAccess);
  if (kind === "adjustment") return canAny(access.can, adjustmentAccess);
  if (kind === "account-transfer") return canAny(access.can, accountTransferAccess);
  if (kind === "account-adjustment") return canAny(access.can, accountAdjustmentAccess);
  if (["payment", "settlement", "offset", "return"].includes(kind)) {
    return (customerParty && canAny(access.can, customerAccess)) || (supplierParty && canAny(access.can, supplierAccess));
  }
  return false;
}

/** Feature screens consume only active documents, on top of the shared access rule. */
export function canReadOperationalDocument(document: ReadModelDocument, access: DocumentReadAccess) {
  return isOperationalDocument(document) && canReadDocument(document, access);
}

/**
 * Operational consumers always see the current party identity by id. The first
 * stored name remains available separately for audit / as-issued presentation.
 */
export function resolveCurrentPartyName(
  document: ReadModelDocument,
  currentPartyNames: ReadonlyMap<string, string>,
) {
  const partyId = partyIdOf(document);
  if (!partyId) return document;
  const currentName = currentPartyNames.get(partyId)?.trim();
  if (!currentName) return document;
  const original = typeof document.partyNameOriginal === "string" ? document.partyNameOriginal.trim() : "";
  const stored = typeof document.partyName === "string" ? document.partyName.trim() : "";
  const snapshot = original || stored;
  return {
    ...document,
    ...(snapshot && snapshot !== currentName ? { partyNameSnapshot: snapshot } : {}),
    partyName: currentName,
  };
}

/** Reversal rows are audit evidence, never an additional operating cash effect. */
export function isEffectiveFinancialMovement(movement: Record<string, unknown>) {
  return movement.status !== "reversed" && movement.isReversal !== true;
}
