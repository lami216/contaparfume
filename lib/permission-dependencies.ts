export type PermissionName = string;

/**
 * Editing or deleting an existing record is only meaningful when the same user
 * can reach and read that workspace. Keep those prerequisites in one place so
 * API principals, permission editing, bootstrap data and navigation cannot drift.
 *
 * Create-only permissions intentionally stay independent: some creation flows
 * are embedded in another workspace (for example customer creation from POS),
 * and must not silently grant broad historical read access.
 *
 * Warehouse transfer/adjustment pre-date explicit view capabilities; their base
 * capabilities are therefore the legacy access/create capability and remain a
 * prerequisite for edit/delete.
 */
const prerequisites: Readonly<Record<PermissionName, readonly PermissionName[]>> = {
  "pos.edit": ["pos.view"],
  "pos.delete": ["pos.view"],
  "purchases.edit": ["purchases.view"],
  "purchases.delete": ["purchases.view"],
  "products.edit": ["products.view"],
  "products.delete": ["products.view"],
  "customers.edit": ["customers.view"],
  "customers.delete": ["customers.view"],
  "customers.collect.edit": ["customers.view"],
  "customers.collect.delete": ["customers.view"],
  "suppliers.edit": ["suppliers.view"],
  "suppliers.delete": ["suppliers.view"],
  "suppliers.pay.edit": ["suppliers.view"],
  "suppliers.pay.delete": ["suppliers.view"],
  "warehouses.edit": ["warehouses.view"],
  "warehouses.delete": ["warehouses.view"],
  "warehouses.transfer.edit": ["warehouses.transfer"],
  "warehouses.transfer.delete": ["warehouses.transfer"],
  "warehouses.adjust.edit": ["warehouses.adjust"],
  "warehouses.adjust.delete": ["warehouses.adjust"],
  "banks.edit": ["banks.view"],
  "banks.delete": ["banks.view"],
  "banks.transfer.edit": ["banks.view"],
  "banks.transfer.delete": ["banks.view"],
  "banks.deposit_withdraw.edit": ["banks.view"],
  "banks.deposit_withdraw.delete": ["banks.view"],
  "banks.balance_correct": ["banks.view"],
  "banks.balance_correct.edit": ["banks.view"],
  "banks.balance_correct.delete": ["banks.view"],
  "expenses.edit": ["expenses.view"],
  "expenses.delete": ["expenses.view"],
  "perfume.divisions.manage": ["perfume.divisions.view"],
};

export function expandPermissionDependencies(permissions: readonly PermissionName[]) {
  const expanded = new Set(permissions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const permission of [...expanded]) {
      for (const prerequisite of prerequisites[permission] ?? []) {
        if (!expanded.has(prerequisite)) {
          expanded.add(prerequisite);
          changed = true;
        }
      }
    }
  }
  return [...expanded];
}

export function removePermissionAndDependents(permissions: readonly PermissionName[], permission: PermissionName) {
  const remaining = new Set(permissions);
  const queue = [permission];
  while (queue.length) {
    const removed = queue.shift()!;
    remaining.delete(removed);
    for (const candidate of [...remaining]) {
      if ((prerequisites[candidate] ?? []).includes(removed)) queue.push(candidate);
    }
  }
  return [...remaining];
}
